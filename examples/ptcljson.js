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
import {toDegrees, toRadians} from '../src/ol/math.js';
import Feature from '../src/ol/Feature.js';
import {Collection, Overlay} from '../src/ol/index.js';
import {bezier, kinks, polygon, unkinkPolygon} from '@turf/turf';
import {toStringHDMS} from '../src/ol/coordinate.js';
import {toLonLat} from '../src/ol/proj.js';

//todo: edit node rotation / heading

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
let modifyFmsLaneType = 'fmsNodes'
let controlType = 'add-nodes'
let modifyDelete = false

const REDRAW_RIBS = 1
const REDRAW_CENTERLINE = 2
const REDRAW_BOUNDARY = 4
let bezierSteps = 16;
/**
 * Our data store, source of truth, draw, modify, delete update this
 * @type {{}}
 */
let fmsPathSections;
let fmsNodes = [];
let fmsLaneSections = [];
const PathSectionStartWeightMeter = 10;
const PathSectionEndWeightMeter = 10;

let showDirectionArrow = true;
const getDirectionArrowStyle = function(feature) {
  const styles = [];
  const centerLineStyle = new Style({
    stroke: new Stroke({
      color: '#33ff4e',
    })
  })
  styles.push(centerLineStyle);
  if (!showDirectionArrow) {
    return styles;
  }
  const centerLine = feature.getGeometry();

  const midPointIx = Math.floor(centerLine.getCoordinates().length / 2)
  const midPointCoord = centerLine.getCoordinates()[midPointIx];
  styles.push(new Style({
      geometry: new Point(midPointCoord),
      image: new CircleStyle({
        radius: 8,
        fill: new Fill({
          color: '#4eff33',
        })
      })
    })
  )

  const prevIx = midPointIx - 1;
  const prevCoord = centerLine.getCoordinates()[prevIx];
  const dx = midPointCoord[0] - prevCoord[0];
  const dy = midPointCoord[1] - prevCoord[1];
  const rotation = Math.atan2(dy, dx);
  styles.push(new Style({
    geometry: new Point(midPointCoord),
    image: new RegularShape({
      fill: new Fill({
        color: '#050505'
      }),
      points: 3,
      radius: 8,
      rotation: -rotation,
      angle: Math.PI / 2 // rotate 90°
    })
  }))
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

  const modifyGeometry = feature.get('modifyGeometry');
  const geometry = modifyGeometry
    ? modifyGeometry.geometry
    : feature.getGeometry();
  console.log('geometry', geometry)
  const result = calculateCenter(geometry);
  const center = result.center;
  if (center) {
    styles.push(
      new Style({
        geometry: new Point(center),
        image: new CircleStyle({
          radius: 14,
          fill: new Fill({
            color: '#ff3333',
          }),
        }),
      })
    );
    const headingStartPoint = center;
    const headingEndPoint = [center[0] + 10, center[1] + 0];
    const headingLineString = new LineString([headingStartPoint, headingEndPoint])
    const fmsNode = feature.get('fmsNode');
    headingLineString.rotate(fmsNode.referenceHeading, center)
    styles.push(
      new Style({
        geometry: headingLineString,
        stroke: new Stroke({
          color: '#ff3333',
        })
      })
    )
    const coordinates = result.coordinates;
    if (coordinates) {
      // style for ribs rotation
      styles.push(
        new Style({
          // geometry: new GeometryCollection([
          //   new MultiPoint(coordinates),
          //   new LineString(coordinates),
          // ]),
          image: new CircleStyle({
            radius: 4,
            fill: new Fill({
              color: '#33cc33',
            }),
          }),
          stroke: new Stroke({
            color: 'blue',
            width: 10,
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
        color: 'rgb(138,133,133)',
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
  style: new Style({
    stroke: new Stroke({
      color: 'rgba(255,0,77,0.97)',
    })
  })
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

const setFmsNodeRotation = () => {
  const fmsNodeId = document.getElementById('fms-node-id').value;
  const referenceHeadingDegree = document.getElementById('fms-node-heading').value;
  fmsNodes.find(fmsNode => fmsNode.id === fmsNodeId).referenceHeading = toRadians(referenceHeadingDegree);
  redrawFmsNodes(fmsNodeId)
}
window.setFmsNodeRotation = setFmsNodeRotation.bind(this);

const setFmsLaneSectionWeights = () => {
  const fmsLaneSectionId = document.getElementById('fms-lane-section-id').value;
  const startWeight = document.getElementById('fms-lane-section-start-weight').value;
  const endWeight = document.getElementById('fms-lane-section-end-weight').value;
  const fmsLaneSection = fmsLaneSections.find(fmsLaneSection => fmsLaneSection.id === fmsLaneSectionId);
  fmsLaneSection.startWeight = parseFloat(startWeight);
  fmsLaneSection.endWeight = parseFloat(endWeight);
  redrawFmsLaneSections(fmsLaneSectionId)
}
window.setFmsLaneSectionWeights = setFmsLaneSectionWeights.bind(this);

map.on('contextmenu', (evt) => {
  console.log('contextmenu', evt)

  content.innerHTML = "";

  if(controlType === 'modify-nodes') {
    const coordinate = evt.coordinate;
    overlay.setPosition(coordinate);

    const snappedFmsNodeFeatures = map.getFeaturesAtPixel(evt.pixel).filter(feat => feat.get('fmsLaneType') === 'fmsNode');
    if (snappedFmsNodeFeatures.length === 0) {
      throw Error('no fmsNode found at drawstart')
    }
    const fmsNode = snappedFmsNodeFeatures[0].get('fmsNode')

    const innerHTML = `
    <div>
      <p>Node: <input type='text' id='fms-node-id' value='${fmsNode.id}' disabled></p>
      <p>Rotation (degree from east): <input id='fms-node-heading' type='text' value='${fmsNode.referenceHeading}'></p>
      <p>Width: <input disabled type='text' value='${fmsNode.leftEdge.distanceFromReferencePoint + fmsNode.rightEdge.distanceFromReferencePoint}'</p>
      <p>Prev Sections: ${fmsNode.prevSectionsId.join(",")} </p>
      <button onclick="window.setFmsNodeRotation()">Set</button>
    </div>    `

    content.innerHTML = innerHTML;
  }
  else if(controlType === 'modify-lane-sections') {
    const coordinate = evt.coordinate;
    overlay.setPosition(coordinate);

    const snappedFmsNodeFeatures = map.getFeaturesAtPixel(evt.pixel).filter(feat => feat.get('fmsLaneType') === 'centerLine');
    if (snappedFmsNodeFeatures.length === 0) {
      throw Error('no fmsNode found at drawstart')
    }
    const fmsLaneSection = snappedFmsNodeFeatures[0].get('fmsLaneSection')

    const innerHTML = `
    <div>
      <p>Lane: <input type='text' id='fms-lane-section-id' value='${fmsLaneSection.id}' disabled></p>
      <p>Start Weight: <input id='fms-lane-section-start-weight' type='text' value='${fmsLaneSection.startWeight}'></p>
      <p>End Weight: <input id='fms-lane-section-end-weight' type='text' value='${fmsLaneSection.endWeight}'></p>

      <button onclick="window.setFmsLaneSectionWeights()">Set</button>
    </div>    `

    content.innerHTML = innerHTML;
  }
  // evt.stopPropagation()
  evt.preventDefault()
})

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

let modifyFmsNodes;
const select = new Select({multi: true});
// select feature first and then modifyRibs selected features
select.on('select', function (e) {

  const selected = select.getFeatures()
  const featuresToModify = new Collection()
  debugger


  selected.forEach(feat => {
    console.log(feat.get('fmsLaneType'), modifyFmsLaneType)

    if(feat.get('fmsLaneType') === modifyFmsLaneType) {
      featuresToModify.push(feat)
    }
  })
  console.log('select', featuresToModify.getArray())

  selected.clear();

  map.removeInteraction(snap)
  map.removeInteraction(ptclSnap)
  map.removeInteraction(modifyFmsNodes)

  modifyFmsNodes = new Modify({
    features: featuresToModify,
    style: function (feature) {
      feature.get('features').forEach(function (modifyFeature) {
        const modifyGeometry = modifyFeature.get('modifyGeometry');
        switch(modifyFeature.get('fmsLaneType')) {
          case 'fmsNode':


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
              const fmsNode = modifyFeature.get('fmsNode')
              if(controlType === 'move-nodes') {
                fmsNode.referencePoint.x = point[0]
                fmsNode.referencePoint.y = point[1]
                const geometry = modifyGeometry.geometry0.clone();
                geometry.getGeometries()[0].setCoordinates(point)
                modifyGeometry.geometry = geometry;
              } else {
                let dx, dy;
                dx = modifyPoint[0] - center[0];
                dy = modifyPoint[1] - center[1];

                const initialAngle = Math.atan2(dy, dx);
                dx = point[0] - center[0];
                dy = point[1] - center[1];
                const currentRadius = Math.sqrt(dx * dx + dy * dy);
                if (currentRadius > 0) {
                  const currentAngle = Math.atan2(dy, dx);
                  const geometry = modifyGeometry.geometry0.clone();
                  geometry.rotate(currentAngle - initialAngle, center);

                  modifyGeometry.geometry = geometry;
                  // const newAngle = currentAngle - initialAngle
                  fmsNode.referenceHeading = toRotationFromEastRad(currentAngle)
                }
              }
            }
            break;
        }
      })
      return getRibsRotationStyle(feature.get('features')[0]);
    }
  });

  modifyFmsNodes.on('modifystart', function (event) {
    event.features.forEach(function (feature) {
      feature.set(
        'modifyGeometry',
        {geometry: feature.getGeometry().clone()},
        true
      );
    });
  });

  // Rib can be deleted by pressing Alt + Click on center point
  modifyFmsNodes.on('modifyend', function (event) {
    event.features.forEach(function (feature) {
      const fmsNode = feature.get('fmsNode')

      const modifyGeometry = feature.get('modifyGeometry');
      if (modifyGeometry)  {
        feature.setGeometry(modifyGeometry.geometry);
        feature.unset('modifyGeometry', true);
        redrawFmsNodes(fmsNode.id)
      }
    });
  });
  map.addInteraction(modifyFmsNodes);
  map.addInteraction(snap)
  map.addInteraction(ptclSnap)
})

const redrawFmsNodes = (fmsNodeId) => {
  const fmsNode = fmsNodes.find(fmsNode => fmsNode.id === fmsNodeId)
  const fmsNodeFeature = addNodesSource.getFeatures().find(feat => feat.get('fmsNodeId') === fmsNodeId)
  const fmsNodeGeomCol = getFmsNodesGeomCol(fmsNode)
  fmsNodeFeature.setGeometry(fmsNodeGeomCol)

  fmsNode.prevSectionsId.forEach(prevSectionId => {
    redrawFmsLaneSections(prevSectionId)
  })
  fmsNode.nextSectionsId.forEach(nextSectionId => {
    redrawFmsLaneSections(nextSectionId)
  })
  //todo: redraw fmsLaneSections
}

const redrawAllFmsLaneSections = () => {
  fmsLaneSections.forEach(fmsLaneSection => {
    redrawFmsLaneSections(fmsLaneSection.id)
  })
}
const redrawFmsLaneSections = (fmsLaneSectionId, bezierSteps) => {
  const fmsLaneSection = fmsLaneSections.find(fmsLaneSection => fmsLaneSection.id === fmsLaneSectionId)
  const startFmsNode = fmsLaneSection.startFmsNode
  const endFmsNode = fmsLaneSection.endFmsNode

  const xUnitVec = new p5.Vector(1, 0)

  const bezierPt1 = startFmsNode.referencePoint
  const pt2 = new p5.Vector(startFmsNode.referencePoint.x, startFmsNode.referencePoint.y)
  const pt2direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
  const pt2startWeight = p5.Vector.mult(pt2direction, fmsLaneSection.startWeight)
  const bezierPt2 = p5.Vector.add(pt2, pt2startWeight)

  const pt3 = new p5.Vector(endFmsNode.referencePoint.x, endFmsNode.referencePoint.y)
  const pt3direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
  const pt3endWeight = p5.Vector.mult(pt3direction, fmsLaneSection.endWeight)
  const bezierPt3 = p5.Vector.sub(pt3, pt3endWeight)

  const bezierPt4 = endFmsNode.referencePoint

  const bezier = new Bezier(
    bezierPt1.x, bezierPt1.y,
    bezierPt2.x, bezierPt2.y,
    bezierPt3.x, bezierPt3.y,
    bezierPt4.x, bezierPt4.y);

  const luts = bezier.getLUT(fmsLaneSection.bezierSteps).map(lut => [lut.x, lut.y])
  console.log('luts', luts.length, luts)

  const centerLine = new LineString(luts)
  centerLineSource.getFeatures().find(feat => feat.get('fmsPathSectionId') === fmsLaneSectionId).setGeometry(centerLine)

  const centerLineCoords = luts;

  const pathSection = {
    elements: []
  }

  for (let i = 1; i < centerLineCoords.length; i++) {
    const curCoord = centerLineCoords[i]
    const prevCoord = centerLineCoords[i-1]
    let prev = new p5.Vector(prevCoord[0], prevCoord[1]);
    let cur = new p5.Vector(curCoord[0], curCoord[1])
    let direction = p5.Vector.sub(cur, prev)

    if (i === 1) {
      let xUnitVec = new p5.Vector(1, 0)
      direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
    }
    else if(i === centerLineCoords.length - 1) {
      let xUnitVec = new p5.Vector(1, 0)
      direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
    }

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
  for (let i = 0; i < pathSection.elements.length; i++) {
    const pathSectionElem = pathSection.elements[i]
    const ribCoords = PtclJSON.calcRibsCoordsInMapProjection(pathSectionElem)
    ribsCoords.push(ribCoords)
  }
  const ribsGeom = PtclJSON.ribsToMultiLineString(ribsCoords)
  ribsSource.getFeatures().find(feat => feat.get('fmsPathSectionId') === fmsLaneSectionId).setGeometry(ribsGeom)

  const boundaryGeom = PtclJSON.getBoundaryGeom(ribsCoords)
  boundarySource.getFeatures().find(feat => feat.get('fmsPathSectionId') === fmsLaneSectionId).setGeometry(boundaryGeom)
}
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

const createNodesGeomCol = function(coordinates, options) {
  const CenterPointIx = 0;
  const LeftRightPointIx = 1;
  const RibIx = 2;

  const geometry = new GeometryCollection([
    new Point(coordinates), //center
    new MultiPoint([]),   //left-right
    new LineString([]) //rib
  ]);

  const geometries = geometry.getGeometries();

  const curCoord = coordinates

  let cur = new p5.Vector(curCoord[0], curCoord[1])
  let directionNorm = new p5.Vector(1, 0)
  directionNorm = p5.Vector.rotate(directionNorm, options.referenceHeading)

  let directionLaneWidth = p5.Vector.mult(directionNorm, options.laneWidth)

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

  return geometry
}

const getFmsNodesGeomCol = function(fmsNode) {
  const coordinates = [fmsNode.referencePoint.x, fmsNode.referencePoint.y];
  const geometry = createNodesGeomCol(coordinates, {
    referenceHeading: fmsNode.referenceHeading,
    laneWidth: fmsNode.leftEdge.distanceFromReferencePoint
  })

  return geometry;
}
/**
 * Draw a node, consisting 1 centerPoint, 1 linestring/rib, 2 left-right points
 * @param coordinates
 * @param geometry
 * @returns {*|GeometryCollection}
 */
const addNodesGeomFn = function(coordinates, geometry) {
  geometry = createNodesGeomCol(coordinates, {
    referenceHeading: 0,
    laneWidth: halfLaneWidthMeter
  })

  let fmsNode = {
    id: uuidv4(),
    referencePoint: { x: coordinates[0], y: coordinates[1] },
    referenceHeading: 0,
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

// const modifyNodes = new Modify({
//   source: addNodesSource,
//   // style: getNodesStyle
// })
// modifyNodes.on('modifystart', (evt) => {
//   // event.features.forEach(function (feature) {
//   //   feature.set(
//   //     'modifyGeometry',
//   //     {geometry: feature.getGeometry().clone()},
//   //     true
//   //   );
//   // });
// })
//
// modifyNodes.on('modifyend', (evt) => {
//   console.log('modifyend', evt)
// })

const addNodes = new Draw({
  type: 'Point',
  source: addNodesSource,
  geometryFunction: addNodesGeomFn,
  style: getNodesStyle
})

addNodes.on('drawend', function(evt) {
  const fmsNode = evt.feature.getGeometry().get('fmsNode')
  //todo: delete fmsNode in evt.feature.getGeometry().get('fmsNode') ?
  evt.feature.set('fmsNodeId', fmsNode.id)
  evt.feature.set('fmsNode', fmsNode)
  evt.feature.set('fmsLaneType', 'fmsNode')
})

const getLaneSectionsStyle = function(feature) {
  const styles = [defaultStyle];
  if(!feature) {
    return styles;
  }
  return styles;
}

const addLaneSectionsDraw = new Draw({
  type: 'LineString',
  source: addLaneSectionSource,
  // geometryFunction: drawLaneSectionsGeomFn,
  style: getLaneSectionsStyle
})

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

  // evt.feature.set('startFmsNode', startFmsNode)
  // evt.feature.set('endFmsNode', endFmsNode)
  const fmsLaneSection = {
    id: fmsPathSectionId,
    startFmsNode: startFmsNode,
    endFmsNode: endFmsNode,
    startWeight: PathSectionStartWeightMeter,
    endWeight: PathSectionEndWeightMeter,
    bezierSteps: bezierSteps
  }
  fmsLaneSections.push(fmsLaneSection)

  const xUnitVec = new p5.Vector(1, 0)

  const bezierPt1 = startFmsNode.referencePoint
  const pt2 = new p5.Vector(startFmsNode.referencePoint.x, startFmsNode.referencePoint.y)
  const pt2direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
  const pt2startWeight = p5.Vector.mult(pt2direction, PathSectionStartWeightMeter)
  const bezierPt2 = p5.Vector.add(pt2, pt2startWeight)

  //todo: not sure if these calc are ALL correct
  const pt3 = new p5.Vector(endFmsNode.referencePoint.x, endFmsNode.referencePoint.y)
  const pt3direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
  const pt3endWeight = p5.Vector.mult(pt3direction, PathSectionEndWeightMeter)
  const bezierPt3 = p5.Vector.sub(pt3, pt3endWeight)

  const bezierPt4 = endFmsNode.referencePoint

  const bezier = new Bezier(
    bezierPt1.x, bezierPt1.y,
    bezierPt2.x, bezierPt2.y,
    bezierPt3.x, bezierPt3.y,
    bezierPt4.x, bezierPt4.y);

  const luts = bezier.getLUT(bezierSteps).map(lut => [lut.x, lut.y])
  console.log('luts', luts.length, luts)

  const centerLine = new LineString(luts)
  const centerLineFeature = new Feature({
    geometry: centerLine,
  })
  centerLineFeature.set('fmsLaneType', 'centerLine')
  centerLineFeature.set('fmsPathSectionId', fmsPathSectionId)
  centerLineFeature.set('fmsLaneSection', fmsLaneSection)
  centerLineSource.addFeature(centerLineFeature)

  const centerLineCoords = luts;

  const pathSection = {
    elements: []
  }

  for (let i = 1; i < centerLineCoords.length; i++) {
    const curCoord = centerLineCoords[i]
    const prevCoord = centerLineCoords[i-1]
    let prev = new p5.Vector(prevCoord[0], prevCoord[1]);
    let cur = new p5.Vector(curCoord[0], curCoord[1])
    let direction = p5.Vector.sub(cur, prev)

    if (i === 1) {
      let xUnitVec = new p5.Vector(1, 0)
      direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
    }
    else if(i === centerLineCoords.length - 1) {
      let xUnitVec = new p5.Vector(1, 0)
      direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
    }

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
  for (let i = 0; i < pathSection.elements.length; i++) {
    const pathSectionElem = pathSection.elements[i]
    const ribCoords = PtclJSON.calcRibsCoordsInMapProjection(pathSectionElem)
    ribsCoords.push(ribCoords)
  }
  const ribsGeom = PtclJSON.ribsToMultiLineString(ribsCoords)
  const ribsFeature = new Feature({
    geometry: ribsGeom
  })
  ribsFeature.set('fmsLaneType', 'ribs')
  ribsFeature.set('fmsPathSectionId', fmsPathSectionId)
  ribsFeature.set('fmsLaneSection', fmsLaneSection)
  ribsSource.addFeature(ribsFeature)

  const boundaryGeom = PtclJSON.getBoundaryGeom(ribsCoords)
  const boundaryFeature = new Feature({
    geometry: boundaryGeom
  })
  boundaryFeature.set('fmsLaneType', 'boundary')
  boundaryFeature.set('fmsPathSectionId', fmsPathSectionId)
  boundaryFeature.set('fmsLaneSection', fmsLaneSection)
  boundarySource.addFeature(boundaryFeature)

  setTimeout(() => {
    // remove drawn straight line from startNode to endNode, now bezier curve exists
    // todo: investigate how to remove without timeout
    addLaneSectionSource.removeFeature(evt.feature)
  }, 0)

});

let drawAndSnapInteractions = [
  addNodes,
  addLaneSectionsDraw,
  // modifyNodes,
  modifyFmsNodes,
  addNodesSnap,
  snap, ptclSnap, centerLineSnap,
  select,
]

map.addInteraction(addNodes);
map.addInteraction(snap);
map.addInteraction(ptclSnap)

/**
 * Currently user has to manually select whether to draw or modify/delete
 * @type {HTMLElement}
 */
const typeSelect = document.getElementById('type');
typeSelect.onchange = function () {
  // drawAndSnapInteractions.forEach(interaction => {
  //   map.removeInteraction(interaction)
  // })
  controlType = typeSelect.value
  switch (controlType) {
    case 'add-nodes':
      map.addInteraction(addNodes)
      map.addInteraction(snap);
      map.addInteraction(ptclSnap)
      modifyDelete = false
      break;
    case 'modify-nodes':
      modifyFmsLaneType = 'fmsNode'
      map.removeInteraction(addLaneSectionsDraw)
      map.removeInteraction(addNodes)
      map.addInteraction(select)
      map.addInteraction(addNodesSnap)
      modifyDelete = false
      break;
    case 'move-nodes':
      modifyFmsLaneType = 'fmsNode'
      map.removeInteraction(addLaneSectionsDraw)
      map.removeInteraction(addNodes)
      map.addInteraction(select)
      map.addInteraction(addNodesSnap)
      break
    case 'add-lane-sections':
      map.removeInteraction(addNodes)
      map.removeInteraction(modifyFmsNodes)

      map.addInteraction(addLaneSectionsDraw)
      map.addInteraction(addNodesSnap)
      modifyDelete = false
      break;
    case 'modify-lane-sections':
      modifyFmsLaneType = 'modify-lane-sections'
      // map.addInteraction(modifyNodes)
      map.addInteraction(centerLineSnap)
      modifyDelete = false
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

// onchange bezier-steps
const bezierStepsInput = document.getElementById('bezier-steps');
bezierSteps = bezierStepsInput.value
bezierStepsInput.onchange = function () {
  bezierSteps = bezierStepsInput.value
  fmsLaneSections.forEach(fmsLaneSection => {
    fmsLaneSection.bezierSteps = bezierSteps
  })
  redrawAllFmsLaneSections()
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
