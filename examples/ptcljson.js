/* eslint-disable */

import Map from '../src/ol/Map.js';
import PtclJSON from '../src/ol/format/PtclJSON.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import proj4 from 'proj4';
import {Circle as CircleStyle, Circle, Fill, RegularShape, Stroke, Style, Text} from '../src/ol/style.js';
import {Tile as TileLayer, Vector as VectorLayer} from '../src/ol/layer.js';
import {register} from '../src/ol/proj/proj4.js';
import {defaults as defaultControls} from '../src/ol/control/defaults.js';
import BingMaps from '../src/ol/source/BingMaps.js';
import {Draw, Modify, Select, Snap} from '../src/ol/interaction.js';
import { v4 as uuidv4 } from 'uuid';
import { Bezier } from "bezier-js";

import {
  GeometryCollection,
  LineString,
  MultiLineString,
  MultiPoint,
  Point,
  Polygon
} from '../src/ol/geom.js';
import {getCenter, getHeight, getWidth} from '../src/ol/extent.js';
import {toDegrees} from '../src/ol/math.js';
import Feature from '../src/ol/Feature.js';
import {Collection, Overlay} from '../src/ol/index.js';
import {bezier, kinks, polygon, unkinkPolygon} from '@turf/turf';

//todo: drawStart snaps to end of 'snapped' pathSection
//todo: drawEnd snaps to start of 'snapped' pathSection
//todo: serialize out into proper file for ingestion into FMS
//todo: split pathSection into multiple pathSections if it is too long
//todo: insert new pathSection for splitting into intersection
//todo: trace on survey data, left hand side ?
//todo: add connectionNode to start and end of pathSection
//todo: address performance issues with lots of ribs features
const MaxLaneLengthMeters = 50;
const MaxLanePoints = 100;
let halfLaneWidthMeter = 8.5;
let modifyType = 'ribs'
let modifyDelete = false

const REDRAW_RIBS = 1
const REDRAW_CENTERLINE = 2
const REDRAW_BOUNDARY = 4

/**
 * Our data store, source of truth, draw, modify, delete update this
 * @type {{}}
 */
let fmsPathSections;
let fmsNodes = [];
const PathSectionStartWeightMeter = 10;
const PathSectionEndWeightMeter = 10;

let showDirectionArrow = false;
const getDirectionArrowStyle = function(feature) {
  const styles = [
    // linestring
    new Style({
      stroke: new Stroke({
        color: 'red',
        width: 2
      })
    })
  ];
  if (!showDirectionArrow) {
    return styles;
  }
  const geometry = feature.getGeometry();

  geometry.forEachSegment(function(start, end, c, d) {
    console.log(c, d)
    var dx = end[0] - start[0];
    var dy = end[1] - start[1];
    var rotation = Math.atan2(dy, dx);

    styles.push(new Style({
      geometry: new Point(end),
      image: new RegularShape({
        fill: new Fill({color: '#000'}),
        points: 3,
        radius: 8,
        rotation: -rotation,
        angle: Math.PI / 2 // rotate 90°
      })
    }));
  });

  return styles;
};


const defaultStyle = new Style({
  image: new Circle({
    radius: 8,
    fill: new Fill({
      color: 'green'
    }),
  }),
  fill: new Fill({
    color: 'rgba(255, 255, 255, 0.6)',
  }),
  stroke: new Stroke({
    color: 'blue',
    width: 4,
  }),
});

const bingLayers = [
  'RoadOnDemand',
  'Aerial',
  'AerialWithLabelsOnDemand',
  'CanvasDark',
  'OrdnanceSurvey',
];

proj4.defs(
  "EPSG:28350",
  "+proj=utm +zone=50 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
);
register(proj4);

function calculateCenter(geometry) {
  let center, coordinates, minRadius;
  const type = geometry.getType();
  if (type === 'Polygon') {
    let x = 0;
    let y = 0;
    let i = 0;
    coordinates = geometry.getCoordinates()[0].slice(1);
    coordinates.forEach(function (coordinate) {
      x += coordinate[0];
      y += coordinate[1];
      i++;
    });
    center = [x / i, y / i];
  } else if (type === 'LineString') {
    center = geometry.getCoordinateAt(0.5);
    coordinates = geometry.getCoordinates();
  } else {
    center = getCenter(geometry.getExtent());
  }

  return {
    center: center,
    coordinates: coordinates
  };
}

const getRibsRotationStyle = function (feature) {
  const styles = [defaultStyle];
  if(!feature) {
    return styles;
  }

  if (feature.getGeometry().getType() === 'GeometryCollection') {
    const boundary = feature.getGeometry().getGeometries()[PtclJSON.BoundaryIx];
    const poly = boundary.getCoordinates();
    const turfPoly = polygon(poly);
    //detect kinks / invalid boundary polygon
    //todo: detect self intersection ?
    const kinks1 = kinks(turfPoly);
    if (kinks1.features.length > 0) {
      styles.push(new Style({
        stroke: new Stroke({
          color: 'red',
          width: 2,
        }),
      }));
    }
    return styles;
  }

  const modifyGeometry = feature.get('modifyGeometry');
  const geometry = modifyGeometry
    ? modifyGeometry.geometry
    : feature.getGeometry();
  const result = calculateCenter(geometry);
  const center = result.center;
  if (center) {
    styles.push(
      new Style({
        geometry: new Point(center),
        image: new CircleStyle({
          radius: 4,
          fill: new Fill({
            color: '#ff3333',
          }),
        }),
      })
    );
    const coordinates = result.coordinates;
    if (coordinates) {
      // style for ribs rotation
      styles.push(
        new Style({
          geometry: new GeometryCollection([
            new MultiPoint(coordinates),
            new LineString(coordinates),
          ]),
          image: new CircleStyle({
            radius: 4,
            fill: new Fill({
              color: '#33cc33',
            }),
          }),
          stroke: new Stroke({
            color: 'blue',
            width: 6,
          }),
        })
      );
    }
  }
  return styles;
}

const centerLineSource = new VectorSource();
const centerLineLayer = new VectorLayer({
  source: centerLineSource,
  style: getDirectionArrowStyle
});
const ribsSource = new VectorSource();
const ribsLayer = new VectorLayer({
  source: ribsSource,
  // style: getRibsRotationStyle
});
const boundarySource = new VectorSource();
const boundaryLayer = new VectorLayer({
  source: boundarySource,
  style: (feature, a, b) => {
    const poly = feature.getGeometry().getCoordinates();
    const turfPoly = polygon(poly);
    const kinks1 = kinks(turfPoly);
    if (kinks1.features.length > 0) {
      return new Style({
        stroke: new Stroke({
          color: 'red',
          width: 2,
        }),
      })
    }

    return new Style({
      stroke: new Stroke({
        color: 'yellow',
        width: 2,
      }),
    })
  }
})

const drawSource = new VectorSource();
const newVector = new VectorLayer({
  source: drawSource,
  style: getRibsRotationStyle
});

const addNodesSource = new VectorSource();
const addNodesLayer = new VectorLayer({
  source: addNodesSource,
  // style: getRibsRotationStyle
});

const addLaneSectionSource = new VectorSource();
const addLaneSectionLayer = new VectorLayer({
  source: addLaneSectionSource,
  // style: getRibsRotationStyle
});


// const ptclSource = new VectorSource({
//   url: 'HazelmerePathSectionsOnlyPtcl.json',
//   format: new PtclJSON({
//     dataProjection: 'EPSG:28350',
//     style: style,
//     mgrsSquare: {
//       utm_zone: 50,
//       lat_band: 'J',
//       column: 'M',
//       row: 'K',
//     },
//     layers: {
//       boundary: boundaryLayer,
//       centerLine: centerLineLayer,
//       ribs: ribsLayer,
//     }
//   }),
//   overlaps: false,
// });

const ptclSource = new VectorSource({
  url: 'flinders.ptcl.json',
  format: new PtclJSON({
    dataProjection: 'EPSG:28350',
    style: defaultStyle,
    mgrsSquare: {
      utm_zone: 50,
      lat_band: 'K',
      column: 'Q',
      row: 'A',
    },
    layers: {
      boundary: boundaryLayer,
      centerLine: centerLineLayer,
      ribs: ribsLayer,
    }
  }),
  overlaps: false,
});

const vectorPtcl = new VectorLayer({
  source: ptclSource,
  style: defaultStyle,
});
vectorPtcl.setVisible(true)
// fmsPathSections = ptclSource.getFeatures();

const bing = new TileLayer({
  visible: true,
  preload: Infinity,
  source: new BingMaps({
    key: 'AlEoTLTlzFB6Uf4Sy-ugXcRO21skQO7K8eObA5_L-8d20rjqZJLs2nkO1RMjGSPN',
    imagerySet: bingLayers[1],
    // use maxZoom 19 to see stretched tiles instead of the BingMaps
    // "no photos at this zoom level" tiles
    maxZoom: 19
  })});

const container = document.getElementById('popup');
const content = document.getElementById('popup-content');
const closer = document.getElementById('popup-closer');

/**
 * Create an overlay to anchor the popup to the map.
 */
const overlay = new Overlay({
  element: container,
  autoPan: {
    animation: {
      duration: 250,
    },
  },
});

/**
 * Add a click handler to hide the popup.
 * @return {boolean} Don't follow the href.
 */
closer.onclick = function () {
  overlay.setPosition(undefined);
  closer.blur();
  return false;
};

const map = new Map({
  controls: defaultControls(),
  layers: [ bing, vectorPtcl, newVector, addNodesLayer, addLaneSectionLayer, ribsLayer, centerLineLayer, boundaryLayer],
  overlays: [overlay],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 2,
  }),
});

let firstLoad = false;

map.on('loadend', function () {
  if(firstLoad) {
    return;
  }
  const feature = boundarySource.getFeatures()[0];
  if (!feature) {
    return;
  }
  fmsPathSections = ptclSource.getFormat().getFmsPathSections()

  const mapView = map.getView()
  mapView.fit(feature.getGeometry().getExtent());
  mapView.setZoom(mapView.getZoom() - 3)
  firstLoad = true;
});

let snap = new Snap({
  source: drawSource,
});
let ptclSnap = new Snap({
  source: ribsSource,
  // source: ptclSource,
});
let centerLineSnap = new Snap({
  source: centerLineSource,
});
let addNodesSnap = new Snap({
  source: addNodesSource,
});

let modifyRibs;
const select = new Select();
// select feature first and then modifyRibs selected features
select.on('select', function (e) {
  const selected = select.getFeatures()
  const featuresToModify = new Collection()
  selected.forEach(feat => {
    if(feat.get('fmsLaneType') === modifyType) {
      featuresToModify.push(feat)
    }
  })
  selected.clear();

  map.removeInteraction(snap)
  map.removeInteraction(ptclSnap)
  map.removeInteraction(modifyRibs)

  modifyRibs = new Modify({
    features: featuresToModify,
    style: function (feature) {
      feature.get('features').forEach(function (modifyFeature) {
        const modifyGeometry = modifyFeature.get('modifyGeometry');
        switch(modifyFeature.get('fmsLaneType')) {
          case 'centerLine':
            if (modifyGeometry) {
              const modifiedCoords = modifyFeature.getGeometry().getCoordinates();

              const pathSectionId = modifyFeature.get('fmsPathSectionId')
              const pathSection = fmsPathSections.find(pathSec => pathSec.id === pathSectionId)
              if(modifiedCoords.length !== pathSection.elements.length) {
                throw new Error('modifiedCoords.length !== pathSection.elements.length')
              }

              for (let i = 0; i <pathSection.elements.length; i++) {
                const rib = pathSection.elements[i];
                rib.referencePoint.x = modifiedCoords[i][0]
                rib.referencePoint.y = modifiedCoords[i][1]
              }
            }
            break;

          case 'ribs':
            if (modifyGeometry) {
              const point = feature.getGeometry().getCoordinates();
              let modifyPoint = modifyGeometry.point;
              if (!modifyPoint) {
                // save the initial geometry and vertex position
                modifyPoint = point;
                modifyGeometry.point = modifyPoint;
                modifyGeometry.geometry0 = modifyGeometry.geometry;
                // get anchor and minimum radius of vertices to be used
                const result = calculateCenter(modifyGeometry.geometry0);
                modifyGeometry.center = result.center;
                modifyGeometry.minRadius = result.minRadius;
              }

              const center = modifyGeometry.center;
              const minRadius = modifyGeometry.minRadius;
              let dx, dy;
              dx = modifyPoint[0] - center[0];
              dy = modifyPoint[1] - center[1];
              const initialRadius = Math.sqrt(dx * dx + dy * dy);
              if (initialRadius > minRadius) {
                const initialAngle = Math.atan2(dy, dx);
                dx = point[0] - center[0];
                dy = point[1] - center[1];
                const currentRadius = Math.sqrt(dx * dx + dy * dy);
                if (currentRadius > 0) {
                  const currentAngle = Math.atan2(dy, dx);
                  const geometry = modifyGeometry.geometry0.clone();
                  geometry.rotate(currentAngle - initialAngle, center);

                  modifyGeometry.geometry = geometry;

                  //modifyRibs stored rib in fmsPathSections based on new angle
                  const pathSectionId = modifyFeature.get('fmsPathSectionId')
                  const pathSection = fmsPathSections.find(pathSec => pathSec.id === pathSectionId)
                  const ribId = modifyFeature.get('fmsRibsId')
                  const rib = pathSection.elements.find(elem => elem.id === ribId);
                  // const newAngle = currentAngle - initialAngle
                  rib.referenceHeading = toRotationFromEastRad(currentAngle)
                }
              }
            }
            break;
        }
      })
      return getRibsRotationStyle(feature.get('features')[0]);
    }
  });

  modifyRibs.on('modifystart', function (event) {
    event.features.forEach(function (feature) {
      feature.set(
        'modifyGeometry',
        {geometry: feature.getGeometry().clone()},
        true
      );
    });
  });

  // Rib can be deleted by pressing Alt + Click on center point
  modifyRibs.on('modifyend', function (event) {
    event.features.forEach(function (feature) {
      const pathSectionId = feature.get('fmsPathSectionId')

      if (modifyDelete) {
        // on delete rib update fmsPathSections, not done in getStyle function
        const pathSection = fmsPathSections.find(pathSec => pathSec.id === pathSectionId)
        const ribId = feature.get('fmsRibsId')
        const ribIx = pathSection.elements.findIndex(elem => elem.id === ribId)
        pathSection.elements.splice(ribIx, 1)
        ribsSource.removeFeature(feature)
        redrawPathSection(pathSectionId, REDRAW_CENTERLINE | REDRAW_BOUNDARY)
      }

      if(modifyType === 'centerLine') {
        select.getFeatures().clear()
        redrawPathSection(pathSectionId, REDRAW_CENTERLINE | REDRAW_BOUNDARY | REDRAW_RIBS)
      }

      const modifyGeometry = feature.get('modifyGeometry');
      if (modifyGeometry)  {
        feature.setGeometry(modifyGeometry.geometry);
        feature.unset('modifyGeometry', true);
        redrawPathSection(pathSectionId, REDRAW_CENTERLINE | REDRAW_BOUNDARY)
      }
    });
  });
  map.addInteraction(modifyRibs);
  map.addInteraction(snap)
  map.addInteraction(ptclSnap)
  // map.addInteraction(centerLineSnap)
})

let useBezier = true

const redrawPathSection = function(pathSectionId, redrawFlags) {
  const pathSection = fmsPathSections.find(pathSec => pathSec.id === pathSectionId)
  const ribsCoords = []
  const centerLineCoords = []
  pathSection.elements.forEach(elem => {
    const ribCoords = PtclJSON.calcRibsCoordsInMapProjection(elem)
    ribsCoords.push(ribCoords)
    centerLineCoords.push(ribCoords[1])
  })

  if (redrawFlags & REDRAW_RIBS) {
    const ribsGeom = new MultiLineString(ribsCoords)
    ribsSource.getFeatures().find(feat => feat.get('fmsPathSectionId') === pathSectionId).setGeometry(ribsGeom)
  }

  if (redrawFlags & REDRAW_CENTERLINE) {
    const centerLineGeom = new LineString(centerLineCoords)
    centerLineSource.getFeatures().find(feat => feat.get('fmsPathSectionId') === pathSectionId).setGeometry(centerLineGeom)
  }

  if (redrawFlags & REDRAW_BOUNDARY) {
    const boundaryGeom = PtclJSON.getBoundaryGeom(ribsCoords)
    boundarySource.getFeatures().find(feat => feat.get('fmsPathSectionId') === pathSectionId).setGeometry(boundaryGeom)
  }
}

/**
 * Draw a node, consisting 1 centerPoint, 1 linestring/rib, 2 left-right points
 * @param coordinates
 * @param geometry
 * @returns {*|GeometryCollection}
 */
const CenterPointIx = 0;
const LeftRightPointIx = 1;
const RibIx = 2;

const drawNodesGeomFn = function(coordinates, geometry) {
  console.log('drawNodesGeomFn', coordinates, geometry)
  let currentIx = coordinates.length-1;
  // if (!geometry) {
  geometry = new GeometryCollection([
    new Point(coordinates), //center
    new MultiPoint([]),   //left-right
    new LineString([]) //rib
  ]);

  const geometries = geometry.getGeometries();

  const curCoord = coordinates

  let cur = new p5.Vector(curCoord[0], curCoord[1])
  let direction = new p5.Vector(1, 0)
  // normalize to 1 meter
  let directionNorm = p5.Vector.normalize(direction)
  // multiply to get half lane width
  let directionLaneWidth = p5.Vector.mult(directionNorm, halfLaneWidthMeter)

  let prevCoordLaneWidthVec = p5.Vector.add(cur, directionLaneWidth);
  let leftRib = new LineString(
    [
      curCoord,
      [prevCoordLaneWidthVec.x, prevCoordLaneWidthVec.y],
    ]);
  leftRib.rotate(Math.PI / 2.0, curCoord);
  let rightRib = new LineString(
    [
      curCoord,
      [prevCoordLaneWidthVec.x, prevCoordLaneWidthVec.y],
    ])
  rightRib.rotate(-Math.PI / 2.0, curCoord);

  let ribLineString = new LineString(
    [
      leftRib.getCoordinates()[1],
      curCoord,
      rightRib.getCoordinates()[1]
    ]
  )
  geometries[RibIx].setCoordinates(ribLineString.getCoordinates());
  //need to do 'setGeometries', simple assignment won't work
  geometry.setGeometries(geometries);

  let first = ribLineString.getCoordinates()[0];
  let last = ribLineString.getCoordinates()[2];

  let v1 = new p5.Vector(first[0], first[1]);
  let v2 = new p5.Vector(last[0], last[1]);
  let dirVec = p5.Vector.sub(v2, v1)
  let rotationFromNorth = dirVec.heading()
  let rotationFromEast = toRotationFromEastRad(rotationFromNorth)

  let fmsNode = {
    id: uuidv4(),
    referencePoint: { x: curCoord[0], y: curCoord[1] },
    referenceHeading: rotationFromEast,
    leftEdge: {
      distanceFromReferencePoint: halfLaneWidthMeter,
    },
    rightEdge: {
      distanceFromReferencePoint: halfLaneWidthMeter,
    },
    nextSectionsId : [],
    prevSectionsId: []
  }
  geometry.set('fmsNode', fmsNode);
  fmsNodes.push(fmsNode);
  return geometry;
}

// const drawLaneSectionsGeomFn = function(coordinates, geometry) {
//   if (!geometry) {
//     geometry = new LineString(coordinates);
//   }
//   geometry.setCoordinates(coordinates);
//   return geometry;
// }

const drawFmsLaneGeomFn = function(coordinates, geometry, proj, d) {
  let currentIx = coordinates.length-1;
  if (!geometry) {
    geometry = new GeometryCollection([
      new Polygon([]), // boundary
      new MultiLineString([[]]),
      new LineString(coordinates)
    ]);
    return geometry;
  }
  if(currentIx === 0) {
    return geometry;
  }
  const geometries = geometry.getGeometries();

  let lineString1;
  if (useBezier) {
    const line = {
      "type": "Feature",
      "properties": {},
      "geometry": {
        "type": "LineString",
        "coordinates": coordinates
      }
    };
    const curved = bezier(line, {resolution: 5000});
    const coordsCurve = curved['geometry']['coordinates'];
    lineString1 = new LineString(coordsCurve);
    if(currentIx >= 3) {
      const bez = new Bezier(
        coordinates[currentIx-3][0],
        coordinates[currentIx-3][1],
        coordinates[currentIx-2][0],
        coordinates[currentIx-2][1],
        coordinates[currentIx-1][0],
        coordinates[currentIx-1][1],
        coordinates[currentIx][0],
        coordinates[currentIx][1]);
      const luts = bez.getLUT(32).map(lut => [lut.x, lut.y])
      console.log('bez', bez, luts)

      lineString1 = new LineString(luts);

    }
  }
  else {
    lineString1 = new LineString(coordinates);
  }

  const centerLineCoords = lineString1.getCoordinates();
  geometries[PtclJSON.CenterLineIx].setCoordinates(centerLineCoords);
  geometries[PtclJSON.RibsIx] = new MultiLineString([[]]);

  const pathSection = {
    elements: []
  }

  // for (let i = 1; i < coordsCurve.length; i++) {
  //   const curCoord = coordsCurve[i]
  //   const prevCoord = coordsCurve[i-1]

  for (let i = 1; i < centerLineCoords.length; i++) {
    const curCoord = centerLineCoords[i]
    const prevCoord = centerLineCoords[i-1]
    let prev = new p5.Vector(prevCoord[0], prevCoord[1]);
    let cur = new p5.Vector(curCoord[0], curCoord[1])
    let direction = p5.Vector.sub(cur, prev)
    if (direction.mag() === 0) {
      continue;
    }

    // normalize to 1 meter
    let directionNorm = p5.Vector.normalize(direction)
    // multiply to get half lane width
    let directionLaneWidth = p5.Vector.mult(directionNorm, halfLaneWidthMeter)
    // translate back to prevCoord
    let prevCoordLaneWidthVec = p5.Vector.add(prev, directionLaneWidth);
    let leftRib = new LineString(
        [
          prevCoord,
          [prevCoordLaneWidthVec.x, prevCoordLaneWidthVec.y],
        ]);
    leftRib.rotate(Math.PI / 2.0, prevCoord);

    let rightRib = new LineString(
      [
        prevCoord,
        [prevCoordLaneWidthVec.x, prevCoordLaneWidthVec.y],
      ]);
    rightRib.rotate(-Math.PI / 2.0, prevCoord);

    let ribLineString = new LineString(
      [
        leftRib.getCoordinates()[1],
        prevCoord,
        rightRib.getCoordinates()[1]
      ]
    )
    let first = ribLineString.getCoordinates()[0];
    let last = ribLineString.getCoordinates()[2];

    let v1 = new p5.Vector(first[0], first[1]);
    let v2 = new p5.Vector(last[0], last[1]);
    let dirVec = p5.Vector.sub(v2, v1)
    let rotationFromNorth = dirVec.heading()
    let rotationFromEast = toRotationFromEastRad(rotationFromNorth)

    let pathSectionElement = {
      id: uuidv4(),
      referencePoint: { x: prevCoord[0], y: prevCoord[1] },
      referenceHeading: rotationFromEast,
      referenceHeadingUnit: 'rad',
      leftEdge: {
        distanceFromReferencePoint: halfLaneWidthMeter,
      },
      rightEdge: {
        distanceFromReferencePoint: halfLaneWidthMeter,
      }
    }
    pathSection.elements.push(pathSectionElement);

    if (i === centerLineCoords.length - 1) {
      let lastPathSectionElement = {
        id: uuidv4(),
        referencePoint: { x: curCoord[0], y: curCoord[1] },
        referenceHeading: rotationFromEast,
        referenceHeadingUnit: 'rad',
        leftEdge: {
          distanceFromReferencePoint: halfLaneWidthMeter,
        },
        rightEdge: {
          distanceFromReferencePoint: halfLaneWidthMeter,
        }
      }
      pathSection.elements.push(lastPathSectionElement);
    }
  }
  const ribsCoords = []
  geometry.set('pathSection', pathSection);
  for (let i = 0; i < pathSection.elements.length; i++) {
    const pathSectionElem = pathSection.elements[i]
    const ribCoords = PtclJSON.calcRibsCoordsInMapProjection(pathSectionElem)
    ribsCoords.push(ribCoords)
  }
  const ribsGeom = PtclJSON.ribsToMultiLineString(ribsCoords)
  ribsGeom.getLineStrings().forEach(ls => geometries[PtclJSON.RibsIx].appendLineString(ls))

  const boundaryGeom = PtclJSON.getBoundaryGeom(ribsCoords)
  geometries[PtclJSON.BoundaryIx].setCoordinates(boundaryGeom.getCoordinates());
  geometry.setGeometries(geometries);
  return geometry;
}

const getNodesStyle = function(feature) {
  const styles = [];
  if(!feature) {
    return styles;
  }
  const centerPointGeom = feature.getGeometry(); // should be Point
  styles.push(new Style({
    geometry: centerPointGeom,
    image: new Circle({
      radius: 4,
      stroke: new Stroke({
        color: 'rgba(0,255,217,1)',
      }),
      fill: new Fill({
        color: 'rgba(0,255,217,0.3)'
      }),
    }),
  }));

  const curCoord = centerPointGeom.getCoordinates();

  let cur = new p5.Vector(curCoord[0], curCoord[1])
  let direction = new p5.Vector(1, 0)
  // normalize to 1 meter
  let directionNorm = p5.Vector.normalize(direction)
  // multiply to get half lane width
  let directionLaneWidth = p5.Vector.mult(directionNorm, halfLaneWidthMeter)

  let prevCoordLaneWidthVec = p5.Vector.add(cur, directionLaneWidth);
  let leftRib = new LineString(
    [
      curCoord,
      [prevCoordLaneWidthVec.x, prevCoordLaneWidthVec.y],
    ]);
  leftRib.rotate(Math.PI / 2.0, curCoord);
  let rightRib = new LineString(
    [
      curCoord,
      [prevCoordLaneWidthVec.x, prevCoordLaneWidthVec.y],
    ])
  rightRib.rotate(-Math.PI / 2.0, curCoord);

  let ribLineString = new LineString(
    [
      leftRib.getCoordinates()[1],
      curCoord,
      rightRib.getCoordinates()[1]
    ]
  )
  styles.push(new Style({
    geometry: ribLineString,
    stroke: new Stroke({
      color: 'rgba(0,255,217,0.9)',
    })
  }))

  return styles;
}

const addNodes = new Draw({
  type: 'Point',
  source: addNodesSource,
  geometryFunction: drawNodesGeomFn,
  style: getNodesStyle
})

addNodes.on('drawend', function(evt) {
  const fmsNode = evt.feature.getGeometry().get('fmsNode')
  //todo: delete fmsNode in evt.feature.getGeometry().get('fmsNode') ?
  evt.feature.set('fmsNode', fmsNode)
  evt.feature.set('fmsLaneType', 'fmsNode')
})

const getLaneSectionsStyle = function(feature) {
  const styles = [defaultStyle];
  if(!feature) {
    return styles;
  }

  if (feature.getGeometry().getType() === 'GeometryCollection') {
    const geometries = feature.getGeometry().getGeometries();
    const centerLineGeom = geometries[PtclJSON.CenterLineIx];
    const centerLineCoords = centerLineGeom.getCoordinates();
    const centerLineLength = centerLineCoords.length;
    if (centerLineLength > 0) {
      const firstCoord = centerLineCoords[0];
      const lastCoord = centerLineCoords[centerLineLength - 1];
      styles.push(new Style({
        geometry: new Point(firstCoord),
        image: new Icon({
          src: 'images/first.svg',
          anchor: [0.5, 0.5],
          scale: 0.5
        })
      }));
      styles.push(new Style({
        geometry: new Point(lastCoord),
        image: new Icon({
          src: 'images/last.svg',
          anchor: [0.5, 0.5],
          scale: 0.5
        })
      }));
    }
  }
  return styles;
}

const addLaneSectionsDraw = new Draw({
  type: 'LineString',
  source: addLaneSectionSource,
  // geometryFunction: drawLaneSectionsGeomFn,
  style: getLaneSectionsStyle
})


/**
 * Draw geometryCollection, when drawend, create features from geometryCollection and
 * add them to respective ribsSource, centerLineSource, boundarySource
 */
const drawFmsLane = new Draw({
  type: 'LineString',
  source: drawSource,
  geometryFunction: drawFmsLaneGeomFn,
  // style: getRibsRotationStyle
});

addLaneSectionsDraw.on('drawstart', (evt) => {
  evt.feature.set('fmsPathSectionId', uuidv4())
  evt.feature.set('fmsLaneType', 'pathSection')
  const snappedFmsNodeFeatures = map.getFeaturesAtPixel(evt.target.downPx_).filter(feat => feat.get('fmsLaneType') === 'fmsNode');
  if (snappedFmsNodeFeatures.length === 0) {
    throw Error('no fmsNode found at drawstart')
  }
  const fmsNode = snappedFmsNodeFeatures[0].get('fmsNode')
  evt.feature.set('startFmsNode', fmsNode)
});

addLaneSectionsDraw.on('drawend', (evt) => {
  const fmsPathSectionId = evt.feature.get('fmsPathSectionId')

  const endFmsNodeFeatures = map.getFeaturesAtPixel(evt.target.downPx_).filter(feat => feat.get('fmsLaneType') === 'fmsNode');
  if (endFmsNodeFeatures.length === 0) {
    throw Error('no fmsNode found at drawend')
  }
  const endFmsNode = endFmsNodeFeatures[0].get('fmsNode')
  endFmsNode.prevSectionsId.push(fmsPathSectionId)

  const startFmsNode = evt.feature.get('startFmsNode')
  startFmsNode.nextSectionsId.push(fmsPathSectionId)

  evt.feature.set('startFmsNode', startFmsNode)
  evt.feature.set('endFmsNode', endFmsNode)
  console.log('drawend fmsNode', evt)
});

drawFmsLane.on('drawstart', (evt) => {
  evt.feature.set('fmsPathSectionId', uuidv4())

  console.log('drawstart', map.getFeaturesAtPixel(evt.target.downPx_))
  const featuresAtPixel = map.getFeaturesAtPixel(evt.target.downPx_)
  // const snappedRib = featuresAtPixel.find(feat => feat.get('fmsLaneType') === 'ribs')
  const snappedRibFeatures = featuresAtPixel.filter(feat => feat.get('fmsLaneType') === 'ribs')
  const endRibOnlyFeatures = snappedRibFeatures.filter(feat => {
    const ribId = feat.get('fmsRibsId')
    return ribId > 0;
  })

  if (endRibOnlyFeatures.length === 0) {
    return;
  }

  console.log('snappedRib', snappedRibFeatures)
  if (snappedRibFeatures.length > 0) {
    const coordinate = evt.target.finishCoordinate_;
    const ribInfos = []

    endRibOnlyFeatures.forEach(rib => {
      const pathSectionId = rib.get('fmsPathSectionId')
      const ribId = rib.get('fmsRibsId')

      const ribInfo = '<code>snapped to rib ' + ribId + ' of pathSection ' + pathSectionId + '</code>';
      ribInfos.push(ribInfo)
    })
    content.innerHTML = ribInfos.join('<br>')
    overlay.setPosition(coordinate);

    const pathSectionId = endRibOnlyFeatures[0].get('fmsPathSectionId')
    const ribId = endRibOnlyFeatures[0].get('fmsRibsId')
    console.log('rib', endRibOnlyFeatures)
    // const rib = fmsPathSections.find(pathSec => pathSec.id === pathSectionId).elements.find(elem => elem.id === ribId)
    evt.feature.set('fmsPrevPathSectionId', pathSectionId)
    evt.feature.set('fmsPrevRibsId', ribId)
  }
})

/**
 * Create new features on ribsLayer, centerLineLayer, BoundaryLayer
 * and clear drawn features to avoid confusion
 */
drawFmsLane.on('drawend', (evt) => {
  const fmsPrevPathSectionId =  evt.feature.get('fmsPrevPathSectionId')
  const fmsPrevRibsId = evt.feature.get('fmsPrevRibsId')

  const geomCol = evt.feature.getGeometry();
  const pathSection = geomCol.get('pathSection')
  pathSection.id = evt.feature.get('fmsPathSectionId')

  if (fmsPrevPathSectionId != null && fmsPrevRibsId != null ) {
    //pathSectionId and ribsId can be 0
    const prevRib = fmsPathSections.find(pathSec => pathSec.id === fmsPrevPathSectionId).elements.find(elem => elem.id === fmsPrevRibsId);

    pathSection.elements[0].referenceHeading = prevRib.referenceHeading
    pathSection.elements[0].leftEdge.distanceFromReferencePoint = prevRib.leftEdge.distanceFromReferencePoint
    pathSection.elements[0].rightEdge.distanceFromReferencePoint = prevRib.rightEdge.distanceFromReferencePoint
  }

  const featuresAtPixel = map.getFeaturesAtPixel(evt.target.downPx_)
  const snappedRib = featuresAtPixel.find(feat => feat.get('fmsLaneType') === 'ribs')
  if (snappedRib) {
    const snapPathSectionId = snappedRib.get('fmsPathSectionId')
    const snapRibId = snappedRib.get('fmsRibsId')
    console.log('rib', snappedRib)
    if (snapPathSectionId != null && snapRibId != null) {
      const nextRib = fmsPathSections.find(pathSec => pathSec.id === snapPathSectionId).elements.find(elem => elem.id === snapRibId);
      pathSection.elements[pathSection.elements.length-1].referenceHeading = nextRib.referenceHeading
      pathSection.elements[pathSection.elements.length-1].leftEdge.distanceFromReferencePoint = nextRib.leftEdge.distanceFromReferencePoint
      pathSection.elements[pathSection.elements.length-1].rightEdge.distanceFromReferencePoint = nextRib.rightEdge.distanceFromReferencePoint
    }
  }

  fmsPathSections.push(pathSection)

  const ribsCoords = []
  let centerLineCoords = [];
  pathSection.elements.forEach(elem => {
    const ribCoords = PtclJSON.calcRibsCoordsInMapProjection(elem)
    ribsCoords.push(ribCoords)
    centerLineCoords.push(ribCoords[1])
    const ribLineString = new LineString(ribCoords)
    const ribFeature = new Feature(ribLineString);
    ribFeature.set('fmsLaneType', 'ribs')
    ribFeature.set('fmsPathSectionId', pathSection.id)
    ribFeature.set('fmsRibsId', elem.id)
    ribsSource.addFeature(ribFeature);
  });

  const boundaryGeom = PtclJSON.getBoundaryGeom(ribsCoords)
  const boundaryFeature = new Feature(boundaryGeom)
  boundaryFeature.set('fmsLaneType', 'boundary')
  boundaryFeature.set('fmsPathSectionId', pathSection.id)
  boundarySource.addFeature(boundaryFeature)

  let centerLineGeom = new LineString(centerLineCoords);
  const centerLineFeature = new Feature(centerLineGeom)
  centerLineFeature.set('fmsLaneType', 'centerLine')
  centerLineFeature.set('fmsPathSectionId', pathSection.id)
  centerLineSource.addFeature(centerLineFeature)

  const vecSource = evt.target.source_;
  setTimeout(() => {
    //todo: investigate why setTimeout is needed, otherwise vecSource is not cleared
    vecSource.clear()
  }, 0)
});

// map.addInteraction(drawFmsLane);
map.addInteraction(addNodes);
map.addInteraction(snap);
map.addInteraction(ptclSnap)
// map.addInteraction(centerLineSnap);

/**
 * Currently user has to manually select whether to draw or modify/delete
 * @type {HTMLElement}
 */
const typeSelect = document.getElementById('type');
typeSelect.onchange = function () {
  let value = typeSelect.value;
  switch (value) {
    case 'draw':
      map.addInteraction(drawFmsLane);
      map.addInteraction(snap);
      // map.addInteraction(centerLineSnap);
      map.removeInteraction(select);
      map.removeInteraction(modifyRibs);
      break;
    case 'add-nodes':
      map.removeInteraction(drawFmsLane);
      map.addInteraction(addNodes)
      modifyDelete = false
      break;
    case 'add-lane-sections':
      map.removeInteraction(drawFmsLane);
      map.removeInteraction(addNodes)
      map.addInteraction(addLaneSectionsDraw)
      map.addInteraction(addNodesSnap)
      modifyDelete = false
      break;

    case 'modify-ribs':
      map.removeInteraction(drawFmsLane);
      map.addInteraction(select);
      modifyDelete = false
      modifyType = 'ribs'
      break;
    case 'delete-ribs':
      modifyType = 'ribs'
      modifyDelete = true
      break;
    case 'modify-centerLine':
      modifyType = 'centerLine'
      break;
  }
};

const laneWidthInput = document.getElementById('lane-width');
halfLaneWidthMeter = laneWidthInput.value / 2
laneWidthInput.onchange = function () {
  halfLaneWidthMeter = laneWidthInput.value / 2
}

const directionArrow = document.getElementById('direction-arrow');
directionArrow.onclick = () => {
  showDirectionArrow = directionArrow.checked
  centerLineLayer.changed()
}

const toRotationFromEastRad = (rotationFromNorthRad) => {
  let rotationFromNorthDegrees = toDegrees(rotationFromNorthRad)
  let toRotationFromEastRad;

  if (rotationFromNorthDegrees > -90 && rotationFromNorthDegrees <= 90) {
    toRotationFromEastRad = rotationFromNorthRad + Math.PI / 2
  } else if (rotationFromNorthDegrees > 90 && rotationFromNorthDegrees <= 180) {
    toRotationFromEastRad = rotationFromNorthRad - Math.PI * 3 / 2
  } else {
    toRotationFromEastRad = rotationFromNorthRad + Math.PI / 2
  }
  return toRotationFromEastRad
}
