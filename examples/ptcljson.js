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

import {
  GeometryCollection,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon
} from '../src/ol/geom.js';
import LinearRing from '../src/ol/geom/LinearRing.js';
import multiLineString from '../build/ol/geom/MultiLineString.js';
import GeoJSON from '../build/ol/format/GeoJSON.js';
import {transform} from '../src/ol/proj.js';
import {getDistance} from '../src/ol/sphere.js';
import {circular} from '../src/ol/geom/Polygon.js';
import {getCenter, getHeight, getWidth} from '../src/ol/extent.js';
import {never} from '../src/ol/events/condition.js';
import {toDegrees} from '../src/ol/math.js';

const key = 'get_your_own_D6rA4zTHduk6KOKTXzGB';
const attributions =
  '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';

const MaxLaneLengthMeters = 50;
const MaxLanePoints = 100;
const BoundaryIx = 0;
const RibsIx = 1;
const CenterLineIx = 2;
const HalfLaneWidthMeter = 10;

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
    color: 'red',
    width: 6,
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


const source = new VectorSource();
const vector = new VectorLayer({
  source: source,
  style: function (feature) {
    const styles = [style];
    const modifyGeometry = feature.get('modifyGeometry');
    const geometry = modifyGeometry
      ? modifyGeometry.geometry
      : feature.getGeometry();

    const ribs = geometry.getGeometries()[RibsIx]
    if (ribs.getLineStrings().length > 0) {
      const coords = ribs.getLineStrings()
        .filter(line => line.getCoordinates().length > 0)
        .map(line => [line.getCoordinates()[0], line.getCoordinates()[2]])
        .flat(1)
      ;
      const ribsLeftRightPoints = new MultiPoint(coords);
      styles.push(
        new Style({
          geometry: ribsLeftRightPoints,
          image: new CircleStyle({
            radius: 20,
            fill: new Fill({
              color: '#33cc33',
            }),
            stroke: new Stroke({
              color: 'rgba(123, 0, 0, 0.7)',
            }),
          }),
          stroke: new Stroke({
            color: '#ffcc33',
            width: 2,
          }),
        })
      );
    }

    return styles;
  }
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
    map.getView().fit(vectorPtcl.values_.source.getFeatures()[0].getGeometry().getExtent());
    firstLoad = true;
  }
});

const select = new Select();

const modifyStyle = new Style({
  image: new CircleStyle({
    radius: 5,
    stroke: new Stroke({
      color: 'rgba(0, 0, 0, 0.7)',
    }),
    fill: new Fill({
      color: 'rgba(0, 0, 0, 0.4)',
    }),
  }),
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

const modify = new Modify({
  source: source,
  insertVertexCondition: never,
  // style: modifyStyle
  style: function (feature) {
    feature.get('features').forEach(function (modifyFeature) {
      // console.log('modifyFeature', modifyFeature)
      const modifyGeometry = modifyFeature.get('modifyGeometry');
      if (modifyGeometry) {

        let modifyRibs = modifyGeometry.ribs
        if (!modifyRibs) {
          modifyRibs = modifyGeometry.geometry.getGeometries()[RibsIx]
          modifyGeometry.ribs = modifyRibs
        }

        // console.log('modifyGeometry',
        //   modifyGeometry.geometry.getGeometries()[RibsIx].getLineStrings().map(line => line.getFlatCoordinates()))
        //
        // console.log('modifyGeometry.ribs', modifyGeometry.ribs.getLineStrings().map(line => line.getFlatCoordinates()))
      }
    })
    // const laneGeomCol = feature.get('features')[0]
    // const modifyGeometry = laneGeomCol.get('modifyGeometry');
    // console.log(modifyGeometry)
    // if (modifyGeometry) {
    //   const point = modifyGeometry.geometry.getGeometries()[1].getCoordinates()
    //   //let modifyPoint =
    //
    // }
    return defaultStyle(feature)
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
  // event.features.forEach(function (feature) {
  //   const modifyGeometry = feature.get('modifyGeometry');
  //   if (modifyGeometry) {
  //     feature.setGeometry(modifyGeometry.geometry);
  //     feature.unset('modifyGeometry', true);
  //   }
  // });
});
//todo: modify ribs: rotate

let lanes = []

const geometryFunctionFmsLane = function(coordinates, geometry, proj, d) {
  // console.log(coordinates, geometry)
  let currentIx = coordinates.length-1;
  // console.log('currentIx', currentIx)
  if (!geometry) {
    geometry = new GeometryCollection([
      new Polygon([]), // boundary
      new MultiLineString([[]]),
      new LineString(coordinates)
    ]);
    geometry.getGeometries()[RibsIx].appendLineString(new LineString([]));
    return geometry;
  }
  const ribsObj = { id: currentIx, pathSections: [] }
  geometry.set('ribs', ribsObj);

  if(currentIx === 0) {
    return geometry;
  }
  const geometries = geometry.getGeometries();

  let lineString1 = new LineString(coordinates);
  const centerLineCoords = lineString1.getCoordinates();
  geometries[CenterLineIx].setCoordinates(centerLineCoords);

  geometries[RibsIx] = new MultiLineString([[]]);

  const ribs = [];
  for (let i = 1; i < coordinates.length; i++) {
    const curCoord = coordinates[i]
    const prevCoord = coordinates[i-1]
    let prev = new Vector(prevCoord[0], prevCoord[1]);
    let cur = new Vector(curCoord[0], curCoord[1])
    let direction = Vector.sub(cur, prev)
    if (Vector.len(direction) === 0) {
      continue;
    }


    // normalize to 1 meter
    let directionNorm = Vector.normalize(direction)
    // multiply to get half lane width
    let directionLaneWidth = Vector.mul(directionNorm, HalfLaneWidthMeter)
    // translate back to prevCoord
    let prevCoordLaneWidthVec = Vector.add(prev, directionLaneWidth);
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
    geometries[RibsIx].appendLineString(ribLineString);
    let first = ribLineString.getCoordinates()[0];
    let last = ribLineString.getCoordinates()[2];

    let v1 = new p5.Vector(first[0], first[1]);
    let v2 = new p5.Vector(last[0], last[1]);
    v2.sub(v1)
    let rotation = v2.heading()
    let rotationDegree = toDegrees(rotation)

    let psElement = {
      referencePoint: { x: prevCoord[0], y: prevCoord[1] },
      referenceHeading: rotation,
      referenceHeadingDegree: rotationDegree
    }
    console.log(rotation, psElement)

    let rib = [
      leftRib.getCoordinates()[1],
      prevCoord,
      rightRib.getCoordinates()[1]
    ]
    ribs.push(rib)
    if (i === coordinates.length - 1) {
      let curCoordLaneWidthVec = Vector.add(cur, directionLaneWidth);
      let lastLeftRib = new LineString(
        [
          curCoord,
          [curCoordLaneWidthVec.x, curCoordLaneWidthVec.y],
        ]);
      lastLeftRib.rotate(Math.PI / 2.0, curCoord);
      // geometries[RibsIx].appendLineString(lastLeftRib);

      let lastRightRib = new LineString(
        [
          curCoord,
          [curCoordLaneWidthVec.x, curCoordLaneWidthVec.y],
        ]);
      lastRightRib.rotate(-Math.PI / 2.0, curCoord);

      let lastRibLineString = new LineString(
        [
          lastLeftRib.getCoordinates()[1],
          curCoord,
          lastRightRib.getCoordinates()[1],
        ]
      )
      geometries[RibsIx].appendLineString(lastRibLineString);

      let rib = [
        lastLeftRib.getCoordinates()[1],
        curCoord,
        lastRightRib.getCoordinates()[1]
      ]
      ribs.push(rib)
    }
  }

  const boundaryGeom = PtclJSON.getBoundary(ribs)
  geometries[BoundaryIx].setCoordinates(boundaryGeom.getCoordinates());
  geometry.setGeometries(geometries);
  return geometry;
}

const drawFmsLane = new Draw({
  type: 'LineString',
  source: source,
  geometryFunction: geometryFunctionFmsLane
});

drawFmsLane.on('drawend', (e) => {
  console.log('drawend', e);
});
drawFmsLane.on('drawstart', (e) => {
  console.log('drawstart', e);
})

const snap = new Snap({
  source: source,
});

map.addInteraction(drawFmsLane);
map.addInteraction(snap);

const typeSelect = document.getElementById('type');
typeSelect.onchange = function () {
  let value = typeSelect.value;
  if (value === 'Draw') {
    map.addInteraction(drawFmsLane);
    map.addInteraction(snap);
    // map.addInteraction(modify);

  } else {
    map.removeInteraction(drawFmsLane);
    map.removeInteraction(snap);

    // map.addInteraction(select);
    map.addInteraction(modify);
  }

};
