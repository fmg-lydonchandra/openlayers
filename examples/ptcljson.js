/* eslint-disable */

import Map from '../src/ol/Map.js';
import PtclJSON from '../src/ol/format/PtclJSON.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import XYZ from '../src/ol/source/XYZ.js';
import proj4 from 'proj4';
import {Fill, Stroke, Style} from '../src/ol/style.js';
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
});

const geometryFunction2 = function(coordinates, geometry) {
  var line = {
    "type": "Feature",
    "properties": {},
    "geometry": {
      "type": "LineString",
      "coordinates": coordinates
    }
  };

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
  // todo: non turfjs bezier so doesn't need geojson
  var curved = turf.bezier(line);

  //todo: turf.buffer returns things in latlong, maybe use jsts?
  // var buffered = turf.buffer(curved, 10, {units: 'meters'});
  // console.log('buffered', buffered);
  if (geometry) {
    geometry.setCoordinates(curved["geometry"]["coordinates"]);

    const jstsGeom = parser.read(geometry);
    const laneWidth = 20;
    const buffered = jstsGeom.buffer(laneWidth / 2.0);
    geometry = parser.write(buffered);
    // debugger

  } else {
    geometry = new LineString(coordinates);
  }

  return geometry;
}

const geometryFunctionPolygon = function(coordinates, geometry) {
  var line = {
    "type": "Feature",
    "properties": {},
    "geometry": {
      "type": "LineString",
      "coordinates": coordinates[0]
    }
  };

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

  var curved = turf.bezier(line);

  //todo: turf.buffer returns things in latlong, maybe use jsts?
  // var buffered = turf.buffer(curved, 10, {units: 'meters'});
  // console.log('buffered', buffered);
  if (geometry) {
    let coords = curved["geometry"]["coordinates"];
    // set last to first, to close polygon
    // coords.push(coords[0]);
    let lineString1 = new LineString(coords);
    // geometry.setCoordinates([coords]);

    const jstsGeom = parser.read(lineString1);
    const laneWidth = 20;
    debugger
    const PERPENDICULAR_TO_FEATURE = 2;
    const buffered = jstsGeom.buffer(laneWidth / 2.0, 6, PERPENDICULAR_TO_FEATURE);
    // const buffered = jsts.operation.buffer.BufferOp.(jstsGeom, laneWidth / 2.0, 1);

    const parsedGeom = parser.write(buffered);
    geometry.setCoordinates(parsedGeom.getCoordinates())

    // geometry.appendLineString(lineString1);
    // const all = geometry.getLineStrings();
    // let last = all[all.length-1];
    // last = lineString1;

    // debugger

  } else {
    geometry = new Polygon([]);
  }

  return geometry;
}


const geometryFunctionFmsLane = function(coordinates, geometry, projection) {
  if (!geometry) {
    geometry = new GeometryCollection([
      new Polygon([]), // boundary
      new Point(coordinates[0]),
      new LineString(coordinates)
    ]);
    return geometry;
  }
  const geometries = geometry.getGeometries();
  // const center = transform(coordinates[0], projection, 'EPSG:4326');
  // const last = transform(coordinates[1], projection, 'EPSG:4326');
  // const radius = getDistance(center, last);
  // const circle = circular(center, radius, 128);
  // circle.transform('EPSG:4326', projection);
  // geometries[0].setCoordinates(circle.getCoordinates());
  var line = {
    "type": "Feature",
    "properties": {},
    "geometry": {
      "type": "LineString",
      "coordinates": coordinates
    }
  };
  var curved = turf.bezier(line);
  let coords = curved["geometry"]["coordinates"];
  geometries[2].setCoordinates([coords]);

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
  let lineString1 = new LineString(coords);
  const jstsGeom = parser.read(lineString1);
  const laneWidth = 20;
  const PERPENDICULAR_TO_FEATURE = 2;
  const buffered = jstsGeom.buffer(laneWidth / 2.0, 6, PERPENDICULAR_TO_FEATURE);
  const parsedGeom = parser.write(buffered);
  geometries[0].setCoordinates(parsedGeom.getCoordinates());
  geometry.setGeometries(geometries);


  return geometry;

  console.log(coordinates, geometry, c, d)
  var line = {
    "type": "Feature",
    "properties": {},
    "geometry": {
      "type": "LineString",
      "coordinates": coordinates[0]
    }
  };



  var curved = turf.bezier(line);

  //todo: turf.buffer returns things in latlong, maybe use jsts?
  // var buffered = turf.buffer(curved, 10, {units: 'meters'});
  // console.log('buffered', buffered);
  if (geometry) {
    let coords = curved["geometry"]["coordinates"];
    // set last to first, to close polygon
    // coords.push(coords[0]);
    let lineString1 = new LineString(coords);
    // geometry.setCoordinates([coords]);

    const jstsGeom = parser.read(lineString1);
    const laneWidth = 20;
    debugger
    const PERPENDICULAR_TO_FEATURE = 2;
    const buffered = jstsGeom.buffer(laneWidth / 2.0, 6, PERPENDICULAR_TO_FEATURE);
    // const buffered = jsts.operation.buffer.BufferOp.(jstsGeom, laneWidth / 2.0, 1);

    const parsedGeom = parser.write(buffered);
    geometry.setCoordinates(parsedGeom.getCoordinates())

    // geometry.appendLineString(lineString1);
    // const all = geometry.getLineStrings();
    // let last = all[all.length-1];
    // last = lineString1;

    // debugger

  } else {
    geometry = new Polygon([]);
  }

  return geometry;
}


const draw = new Draw({
  type: 'LineString',
  // type: 'Polygon',
  source: vectorPtcl,
  geometryFunction: geometryFunction2
});

const drawPolygon = new Draw({
  type: 'Polygon',
  source: source,
  geometryFunction: geometryFunctionPolygon
});

const drawFmsLane = new Draw({
  type: 'LineString',
  source: source,
  geometryFunction: geometryFunctionFmsLane
});

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


// map.addInteraction(select);
// map.addInteraction(modify);
// map.addInteraction(draw);
// map.addInteraction(drawPolygon);
map.addInteraction(drawFmsLane);
map.addInteraction(snap);
