/* eslint-disable */

import Map from '../src/ol/Map.js';
import PtclJSON from '../src/ol/format/PtclJSON.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import XYZ from '../src/ol/source/XYZ.js';
import proj4 from 'proj4';
import {Circle as CircleStyle, Circle, Fill, Stroke, Style, Text} from '../src/ol/style.js';
import {Tile as TileLayer, Vector as VectorLayer} from '../src/ol/layer.js';
import {register} from '../src/ol/proj/proj4.js';
import TopoJSON from '../src/ol/format/TopoJSON.js';
import {defaults as defaultControls} from '../src/ol/control/defaults.js';
import {ZoomToExtent} from '../src/ol/control.js';
import BingMaps from '../src/ol/source/BingMaps.js';
import {Draw, Modify, Select, Snap} from '../src/ol/interaction.js';
import { v4 as uuidv4 } from 'uuid';

import {
  GeometryCollection,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon
} from '../src/ol/geom.js';
import {getCenter, getHeight, getWidth} from '../src/ol/extent.js';
import {never, platformModifierKeyOnly, primaryAction} from '../src/ol/events/condition.js';
import {toDegrees} from '../src/ol/math.js';
import Feature from '../src/ol/Feature.js';
import {Collection} from '../src/ol/index.js';

const MaxLaneLengthMeters = 50;
const MaxLanePoints = 100;
const BoundaryIx = 0;
const RibsIx = 1;
const CenterLineIx = 2;
const HalfLaneWidthMeter = 10;
let modifyType = 'ribs'

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
      console.log('coordinates', coordinates)
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

const ptclSourceSnap = new VectorSource({
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

const vectorPtclSnap = new VectorLayer({
  source: ptclSourceSnap,
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
  layers: [ bing, vectorPtcl, vectorPtclSnap, vector ],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 2,
  }),
});

var firstLoad = false;

map.on('loadend', function () {
  console.log('loadend')
  if (!firstLoad) {
    const feature = vectorPtcl.values_.source.getFeatures()[0];
    console.log('feature', feature)
    const mapView = map.getView()
    mapView.fit(feature.getGeometry().getGeometries()[PtclJSON.BoundaryIx].getExtent());
    mapView.setZoom(mapView.getZoom() - 2)
    firstLoad = true;
  }
});

const select = new Select({
  // style: (feature) => {
  //   console.log(feature)
  // }
});

const modifyStyle = new Style({
  text: new Text({
    text: 'Drag to modify',
    font: '12px Calibri,sans-serif',
    fill: new Fill({
      color: 'rgba(255, 255, 255, 1)',
    }),
    backgroundFill: new Fill({
      color: 'rgba(0, 0, 0, 0.7)',
    }),
    padding: [2, 2, 2, 2],
    textAlign: 'left',
    offsetX: 15,
  }),
});

const defaultStyle = new Modify({source: source})
  .getOverlay()
  .getStyleFunction();

let modify = new Modify({
  source: source,
  insertVertexCondition: never,
  // style: modifyStyle
  style: function (feature) {
  }
});

const createFeaturesToModify = (features, modifyType) => {
  const featuresRetVal = []
  switch(modifyType) {
    case 'ribs': {
      features.forEach(feat => {
        const geometry = feat.getGeometry()
        if (geometry.getType() === 'GeometryCollection') {
          const ribsLineStrings = geometry.getGeometries()[RibsIx].getLineStrings()
          ribsLineStrings.forEach(ribLs => {
            const ribsFeature = new Feature(ribLs)
            featuresRetVal.push(ribsFeature)
          })
        }
      });
    }
    break;
    case 'centerLine': {

    }
    break;
  }
  return new Collection(featuresRetVal);
}

let snap = new Snap({
  source: source,
});

select.on('select', function (e) {
  const selected = select.getFeatures()
  const featuresToModify = createFeaturesToModify(selected, modifyType)
  console.log('on select', selected)

  map.removeInteraction(snap)
  map.removeInteraction(modify)

  modify = new Modify({
    features: featuresToModify,
    deleteCondition: never,
    condition: function (event) {
      return primaryAction(event) && !platformModifierKeyOnly(event);
    },
    insertVertexCondition: never,
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
              geometry.scale(1, undefined, center);
              geometry.rotate(currentAngle - initialAngle, center);
              modifyGeometry.geometry = geometry;
            }
          }
        }
      })

      const styles = getStyle1(feature.get('features')[0]);
      console.log('styles', styles)
      return styles

    }
  });

  modify.on('modifystart', function (event) {
    event.features.forEach(function (feature) {
      feature.set(
        'modifyGeometry',
        {geometry: feature.getGeometry().clone()},
        true
      );
    });
  });

  modify.on('modifyend', function (event) {
    event.features.forEach(function (feature) {
      const modifyGeometry = feature.get('modifyGeometry');
      if (modifyGeometry) {
        feature.setGeometry(modifyGeometry.geometry);
        feature.unset('modifyGeometry', true);
      }
    });
  });
  map.addInteraction(modify);
  map.addInteraction(snap)
})


const geometryFunctionFmsLane = function(coordinates, geometry, proj, d) {
  let currentIx = coordinates.length-1;
  if (!geometry) {
    geometry = new GeometryCollection([
      new Polygon([]), // boundary
      new MultiLineString([[]]),
      new LineString(coordinates)
    ]);
    geometry.getGeometries()[RibsIx].appendLineString(new LineString([]));
    return geometry;
  }
  if(currentIx === 0) {
    return geometry;
  }
  const geometries = geometry.getGeometries();

  let lineString1 = new LineString(coordinates);
  const centerLineCoords = lineString1.getCoordinates();
  geometries[CenterLineIx].setCoordinates(centerLineCoords);
  geometries[RibsIx] = new MultiLineString([[]]);

  const pathSectionElems = [];
  for (let i = 1; i < coordinates.length; i++) {
    const curCoord = coordinates[i]
    const prevCoord = coordinates[i-1]
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
    pathSectionElems.push(pathSectionElement);

    if (i === coordinates.length - 1) {
      let lastPathSectionElement = {
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
      pathSectionElems.push(lastPathSectionElement);
    }
  }
  // console.log(pathSectionElems)
  const ribsCoords = []
  geometry.set('pathSections', pathSectionElems);
  for (let i = 0; i < pathSectionElems.length; i++) {
    const pathSectionElem = pathSectionElems[i]
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

const drawFmsLane = new Draw({
  type: 'LineString',
  source: source,
  geometryFunction: geometryFunctionFmsLane
});

drawFmsLane.on('drawend', (evt) => {
  // const geomCol = evt.feature.getGeometry();
  //
  // if (geomCol.getType() !== 'GeometryCollection') {
  //   return;
  // }
  // const geometries = geomCol.getGeometries()
  // const ribsGeom = geometries[PtclJSON.RibsIx]
  // ribsGeom.getLineStrings().forEach(rib => {
  //   if (rib.getCoordinates().length === 0) {
  //     return;
  //   }
  //   console.log('rib', rib, rib.getCoordinates())
  //   const ribFeature = new Feature(rib);
  //   //todo: add property to link rib with pathSection..id etc
  //   const sourceLayer = evt.target.source_;
  //   console.log('ribFeature', ribFeature)
  //   sourceLayer.addFeature(ribFeature);
  // })
});
drawFmsLane.on('drawstart', (e) => {
  console.log('drawstart', e);
})


map.addInteraction(drawFmsLane);
map.addInteraction(snap);

const typeSelect = document.getElementById('type');
typeSelect.onchange = function () {
  let value = typeSelect.value;
  if (value === 'Draw') {
    map.addInteraction(drawFmsLane);
    map.addInteraction(snap);
    map.removeInteraction(select);
    // map.addInteraction(modify);

  } else {
    map.removeInteraction(drawFmsLane);
    // map.removeInteraction(snap);

    map.addInteraction(select);
    if (value === 'Modify - Ribs') {
      modifyType = 'ribs'
    } else if (value === 'Modify - CenterLine') {
      modifyType = 'centerLine'
    }
    // map.addInteraction(modify);
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
