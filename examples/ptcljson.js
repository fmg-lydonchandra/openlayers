/* eslint-disable */

import Map from '../src/ol/Map.js';
import PtclJSON from '../src/ol/format/PtclJSON.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import XYZ from '../src/ol/source/XYZ.js';
import proj4 from 'proj4';
import {Circle, Fill, Stroke, Style} from '../src/ol/style.js';
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

const key = 'get_your_own_D6rA4zTHduk6KOKTXzGB';
const attributions =
  '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';

const parser = new jsts.io.OL3Parser();
parser.inject(
  Point,
  LineString,
  LinearRing,
  Polygon,
  MultiPoint,
  MultiLineString,
  MultiPolygon
);

const raster = new TileLayer({
  source: new XYZ({
    attributions: attributions,
    // url: 'https://api.maptiler.com/maps/darkmatter/{z}/{x}/{y}.png?key=' + key,
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',

    tileSize: 512,
  }),
});

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


const source = new VectorSource({wrapX: false});
const vector = new VectorLayer({
  source: source,
});


const vector2 = new VectorLayer({
  source: new VectorSource({
    url: 'data/topojson/world-110m.json',
    format: new TopoJSON({
      // don't want to render the full world polygon (stored as 'land' layer),
      // which repeats all countries
      layers: ['countries'],
    }),
    overlaps: false,
  }),
  style: style,
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

const geojsonSource = new VectorSource({
  url: 'HazelmerePathSectionsOnlyPtcl.json',
  format: new GeoJSON(),
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
    // maxZoom: 19
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

const modify = new Modify({
  features: select.getFeatures(),
  insertVertexCondition: false
});

const MaxLaneLengthMeters = 50;
const MaxLanePoints = 100;
const BoundaryIx = 0;
const RibsIx = 1;
const CenterLineIx = 2;
const HalfLaneWidthMeter = 10;
const geometryFunctionFmsLane = function(coordinates, geometry) {
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

  if(currentIx === 0) {
    return geometry;
  }
  const geometries = geometry.getGeometries();

  // const parser = new jsts.io.OL3Parser();
  // parser.inject(
  //   Point,
  //   LineString,
  //   LinearRing,
  //   Polygon,
  //   MultiPoint,
  //   MultiLineString,
  //   MultiPolygon
  // );
  let lineString1 = new LineString(coordinates);
  // lineString1 = lineString1.simplify(MaxLaneLengthMeters / MaxLanePoints )
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
    geometries[RibsIx].appendLineString(leftRib);

    let rightRib = new LineString(
      [
        prevCoord,
        [prevCoordLaneWidthVec.x, prevCoordLaneWidthVec.y],
      ]);
    rightRib.rotate(-Math.PI / 2.0, prevCoord);
    geometries[RibsIx].appendLineString(rightRib);

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
      geometries[RibsIx].appendLineString(lastLeftRib);

      let lastRightRib = new LineString(
        [
          curCoord,
          [curCoordLaneWidthVec.x, curCoordLaneWidthVec.y],
        ]);
      lastRightRib.rotate(-Math.PI / 2.0, curCoord);
      geometries[RibsIx].appendLineString(lastRightRib);

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

  // console.log(geometries[RibsIx].getLineStrings())


  // const jstsGeom = parser.read(lineString1);
  // const PERPENDICULAR_TO_FEATURE = 2;
  // const buffered = jstsGeom.buffer(HalfLaneWidthMeter, 6, PERPENDICULAR_TO_FEATURE);
  // const bufferedGeom = parser.write(buffered);
  // geometries[BoundaryIx].setCoordinates(bufferedGeom.getCoordinates());
  geometry.setGeometries(geometries);

  // console.log(coordinates, geometry)
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
// draw.on('drawend', function(e) {
//   var lineString = e.feature.getGeometry();
//   console.log('drawend', lineString)
//
//   var multiLineString = new MultiLineString([]);
//   multiLineString.appendLineString(lineString);
//   var size = lineString.getLength() / 20; // or use a fixed size if you prefer
//   var coords = lineString.getCoordinates();
//   // start
//   var dx = coords[1][0] - coords[0][0];
//   var dy = coords[1][1] - coords[0][1];
//   var rotation = Math.atan2(dy, dx);
//   var startLine = new LineString([
//     [coords[0][0], coords[0][1] - size],
//     [coords[0][0], coords[0][1] + size]
//   ]);
//   startLine.rotate(rotation, coords[0]);
//   // end
//   var lastIndex = coords.length - 1;
//   var dx = coords[lastIndex - 1][0] - coords[lastIndex][0];
//   var dy = coords[lastIndex - 1][1] - coords[lastIndex][1];
//   var rotation = Math.atan2(dy, dx);
//   var endLine = new LineString([
//     [coords[lastIndex][0], coords[lastIndex][1] - size],
//     [coords[lastIndex][0], coords[lastIndex][1] + size]
//   ]);
//   endLine.rotate(rotation, coords[lastIndex]);
//   multiLineString.appendLineString(startLine);
//   multiLineString.appendLineString(endLine);
//   e.feature.setGeometry(multiLineString);
// });

const snap = new Snap({
  source: ptclSourceSnap,
});

map.addInteraction(drawFmsLane);
map.addInteraction(snap);

const typeSelect = document.getElementById('type');
typeSelect.onchange = function () {
  let value = typeSelect.value;
  if (value === 'Draw') {
    map.addInteraction(drawFmsLane);
    map.addInteraction(snap);
  } else {
    map.removeInteraction(drawFmsLane);
    map.removeInteraction(snap);

    map.addInteraction(select);
    map.addInteraction(modify);
  }

};
