/* eslint-disable */

import Map from '../src/ol/Map.js';
import PtclJSON from '../src/ol/format/PtclJSON.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import proj4 from 'proj4';
import {Circle as CircleStyle, Circle, Fill, Stroke, Style, Text} from '../src/ol/style.js';
import {Tile as TileLayer, Vector as VectorLayer} from '../src/ol/layer.js';
import {register} from '../src/ol/proj/proj4.js';
import {defaults as defaultControls} from '../src/ol/control/defaults.js';
import BingMaps from '../src/ol/source/BingMaps.js';
import {Draw, Modify, Select, Snap} from '../src/ol/interaction.js';
import { v4 as uuidv4 } from 'uuid';

import {
  GeometryCollection,
  LineString,
  MultiLineString,
  MultiPoint,
  Point,
  Polygon
} from '../src/ol/geom.js';
import {getCenter, getHeight, getWidth} from '../src/ol/extent.js';
import {never, platformModifierKeyOnly, primaryAction} from '../src/ol/events/condition.js';
import {toDegrees} from '../src/ol/math.js';
import Feature from '../src/ol/Feature.js';
import {Collection} from '../src/ol/index.js';
import {bezier, kinks, polygon, unkinkPolygon} from '@turf/turf';

//todo: trace on survey data, left hand side ?
//todo: add connectionNode to start and end of pathSection
//todo: add direction arrow to centerline
//todo: only snap at start or end of pathSection (not in middle)

const MaxLaneLengthMeters = 50;
const MaxLanePoints = 100;
const BoundaryIx = 0;
const RibsIx = 1;
const CenterLineIx = 2;
const HalfLaneWidthMeter = 10;
let modifyType = 'ribs'
let modifyDelete = false

const REDRAW_RIBS = 1
const REDRAW_CENTERLINE = 2
const REDRAW_BOUNDARY = 4

/**
 * Our data store
 * @type {{}}
 */
const fmsPathSections = {}

const style = new Style({
  image: new Circle({
    radius: 5,
    fill: new Fill({
      color: 'rgba(255,255,255,0.4)'
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

const styles = [
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
  let sqDistances;
  if (coordinates) {
    sqDistances = coordinates.map(function (coordinate) {
      const dx = coordinate[0] - center[0];
      const dy = coordinate[1] - center[1];
      return dx * dx + dy * dy;
    });
    minRadius = Math.sqrt(Math.max.apply(Math, sqDistances)) / 3;
  } else {
    minRadius =
      Math.max(
        getWidth(geometry.getExtent()),
        getHeight(geometry.getExtent())
      ) / 3;
  }
  return {
    center: center,
    coordinates: coordinates,
    minRadius: minRadius,
    sqDistances: sqDistances,
  };
}

const getStyle1 = function (feature) {
  const styles = [style];
  if(!feature) {
    return styles;
  }

  if (feature.getGeometry().getType() === 'GeometryCollection') {
    const boundary = feature.getGeometry().getGeometries()[BoundaryIx];
    const poly = boundary.getCoordinates();
    const turfPoly = polygon(poly);
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
  style: new Style({
    stroke: new Stroke({
      color: 'red',
      width: 4,
    }),
  })
});
const ribsSource = new VectorSource();
const ribsLayer = new VectorLayer({
  source: ribsSource,
  style: getStyle1
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

const source = new VectorSource();
const vector = new VectorLayer({
  source: source,
  style: getStyle1
});
const ptclSource = new VectorSource({
  url: 'HazelmerePathSectionsOnlyPtcl.json',
  format: new PtclJSON({
    dataProjection: 'EPSG:28350',
    style: style,
    mgrsSquare: {
      utm_zone: 50,
      lat_band: 'J',
      column: 'M',
      row: 'K',
    }
  }),
  overlaps: false,
});
const vectorPtcl = new VectorLayer({
  source: ptclSource,
  style: style,
});

const bing = new TileLayer({
  visible: true,
  preload: Infinity,
  source: new BingMaps({
    key: 'AlEoTLTlzFB6Uf4Sy-ugXcRO21skQO7K8eObA5_L-8d20rjqZJLs2nkO1RMjGSPN',
    imagerySet: styles[1],
    // use maxZoom 19 to see stretched tiles instead of the BingMaps
    // "no photos at this zoom level" tiles
    maxZoom: 19
  })});

const map = new Map({
  controls: defaultControls(),
  layers: [ bing, vectorPtcl, vector, ribsLayer, centerLineLayer, boundaryLayer],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 2,
  }),
});

var firstLoad = false;

map.on('loadend', function () {
  if (!firstLoad) {
    const feature = vectorPtcl.values_.source.getFeatures()[0];
    const mapView = map.getView()
    mapView.fit(feature.getGeometry().getGeometries()[PtclJSON.BoundaryIx].getExtent());
    mapView.setZoom(mapView.getZoom() - 2)
    firstLoad = true;
  }
});

const select = new Select({});

let modifyRibs = new Modify({
  source: source,
  insertVertexCondition: never,
  style: function (feature) {}
});

let snap = new Snap({
  source: source,
});
let ptclSnap = new Snap({
  source: ptclSource,
});
let centerLineSnap = new Snap({
  source: centerLineSource,
});

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
    // deleteCondition: never,
    // condition: function (event) {
    //   return primaryAction(event) && !platformModifierKeyOnly(event);
    // },
    style: function (feature) {
      feature.get('features').forEach(function (modifyFeature) {
        const modifyGeometry = modifyFeature.get('modifyGeometry');
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
              const pathSection = fmsPathSections[pathSectionId]
              const ribId = modifyFeature.get('fmsRibsId')
              const rib = pathSection.elements.find(elem => elem.id === ribId);
              // const newAngle = currentAngle - initialAngle
              rib.referenceHeading = toRotationFromEastRad(currentAngle)
            }
          }
        }
      })
      return getStyle1(feature.get('features')[0]);
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
        // on delete rib update fmsPathSections
        const pathSection = fmsPathSections[pathSectionId]
        const ribId = feature.get('fmsRibsId')
        const ribIx = pathSection.elements.findIndex(elem => elem.id === ribId)
        pathSection.elements.splice(ribIx, 1)
        ribsSource.removeFeature(feature)
        redrawPathSection(pathSectionId, REDRAW_CENTERLINE | REDRAW_BOUNDARY)
        return;
      }

      const modifyGeometry = feature.get('modifyGeometry');
      if (modifyGeometry) {
        feature.setGeometry(modifyGeometry.geometry);
        feature.unset('modifyGeometry', true);
        redrawPathSection(pathSectionId, REDRAW_CENTERLINE | REDRAW_BOUNDARY)
      }
    });
  });
  map.addInteraction(modifyRibs);
  map.addInteraction(snap)
  map.addInteraction(ptclSnap)
  map.addInteraction(centerLineSnap)
})

let useBezier = false

const redrawPathSection = function(pathSectionId, redrawFlags) {
  const pathSection = fmsPathSections[pathSectionId]
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

const geometryFunctionFmsLane = function(coordinates, geometry, proj, d) {
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
    var line = {
      "type": "Feature",
      "properties": {},
      "geometry": {
        "type": "LineString",
        "coordinates": coordinates
      }
    };
    const curved = bezier(line, {resolution: 500});
    const coordsCurve = curved['geometry']['coordinates'];
    lineString1 = new LineString(coordsCurve);
  }
  else {
    lineString1 = new LineString(coordinates);
  }

  const centerLineCoords = lineString1.getCoordinates();
  geometries[CenterLineIx].setCoordinates(centerLineCoords);
  geometries[RibsIx] = new MultiLineString([[]]);

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
    let directionLaneWidth = p5.Vector.mult(directionNorm, HalfLaneWidthMeter)
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
        distanceFromReferencePoint: HalfLaneWidthMeter,
      },
      rightEdge: {
        distanceFromReferencePoint: HalfLaneWidthMeter,
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
          distanceFromReferencePoint: HalfLaneWidthMeter,
        },
        rightEdge: {
          distanceFromReferencePoint: HalfLaneWidthMeter,
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
  ribsGeom.getLineStrings().forEach(ls => geometries[RibsIx].appendLineString(ls))

  const boundaryGeom = PtclJSON.getBoundaryGeom(ribsCoords)
  geometries[BoundaryIx].setCoordinates(boundaryGeom.getCoordinates());
  geometry.setGeometries(geometries);
  return geometry;
}

/**
 * Draw geometryCollection, when drawend, create features from geometryCollection and
 * add them to respective ribsSource, centerLineSource, boundarySource
 */
const drawFmsLane = new Draw({
  type: 'LineString',
  source: source,
  geometryFunction: geometryFunctionFmsLane,
  style: getStyle1
});

drawFmsLane.on('drawstart', (evt) => {
  evt.feature.set('fmsPathSectionId', uuidv4())

  console.log('drawstart', map.getFeaturesAtPixel(evt.target.downPx_))
  const featuresAtPixel = map.getFeaturesAtPixel(evt.target.downPx_)
  const snappedRibs = featuresAtPixel.find(feat => feat.get('fmsLaneType') === 'ribs')
  if (snappedRibs) {
    //todo: edit connection ribs, synchronise them
    const pathSectionId = snappedRibs.get('fmsPathSectionId')
    const ribId = snappedRibs.get('fmsRibsId')
    const rib = fmsPathSections[pathSectionId].elements.find(elem => elem.id === ribId)
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

  if (fmsPrevPathSectionId && fmsPrevRibsId) {
    //todo: set ribs to same reference heading
    const prevRibsReferenceHeading = fmsPathSections[fmsPrevPathSectionId].elements.find(elem => elem.id === fmsPrevRibsId).referenceHeading
    pathSection.elements[0].referenceHeading = prevRibsReferenceHeading
  }
  fmsPathSections[pathSection.id] = pathSection

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
    vecSource.clear()
  }, 0)
});

map.addInteraction(drawFmsLane);
map.addInteraction(snap);
map.addInteraction(ptclSnap)
map.addInteraction(centerLineSnap);

const typeSelect = document.getElementById('type');
typeSelect.onchange = function () {
  let value = typeSelect.value;
  if (value === 'Draw') {
    map.addInteraction(drawFmsLane);
    map.addInteraction(snap);
    map.addInteraction(centerLineSnap);
    map.removeInteraction(select);
    map.removeInteraction(modifyRibs);

  } else {
    map.removeInteraction(drawFmsLane);

    map.addInteraction(select);
    modifyDelete = false
    if (value === 'Modify - Ribs') {
      modifyType = 'ribs'
    } else if (value === 'Delete - Ribs') {
      modifyType = 'ribs'
      modifyDelete = true
    } else if (value === 'Modify - CenterLine') {
      modifyType = 'centerLine'
    }
  }
};

const toRotationFromEastRad = (rotationFromNorthRad) => {
  let rotationFromNorthDegrees = toDegrees(rotationFromNorthRad)
  let toRotationFromEastRad;

  if (rotationFromNorthDegrees > -90 && rotationFromNorthDegrees <= 90) {
    toRotationFromEastRad = rotationFromNorthRad + Math.PI / 2
  }
  else if (rotationFromNorthDegrees > 90 && rotationFromNorthDegrees <= 180) {
    toRotationFromEastRad = rotationFromNorthRad - Math.PI*3/2
  }
  else {
    toRotationFromEastRad = rotationFromNorthRad + Math.PI / 2
  }
  return toRotationFromEastRad
}
