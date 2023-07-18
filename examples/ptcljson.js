/* eslint-disable */

import Map from '../src/ol/Map.js';
import PtclJSON from '../src/ol/format/PtclJSON.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import proj4 from 'proj4';
import {Circle as CircleStyle, Circle, Fill, RegularShape, Stroke, Style} from '../src/ol/style.js';
import {Tile as TileLayer, Vector as VectorLayer} from '../src/ol/layer.js';
import WebGLTileLayer from '../src/ol/layer/WebGLTile.js';

import {register} from '../src/ol/proj/proj4.js';
import {defaults as defaultControls} from '../src/ol/control/defaults.js';
import BingMaps from '../src/ol/source/BingMaps.js';
import {Draw, Modify, Select, Snap} from '../src/ol/interaction.js';
import {v4 as uuidv4} from 'uuid';
import {Bezier} from 'bezier-js';

import {GeometryCollection, LineString, MultiLineString, MultiPoint, Point} from '../src/ol/geom.js';
import {getCenter} from '../src/ol/extent.js';
import {toDegrees, toRadians} from '../src/ol/math.js';
import Feature from '../src/ol/Feature.js';
import {Collection, Overlay} from '../src/ol/index.js';
import {kinks, polygon} from '@turf/turf';
import fitCurve from 'fit-curve';
import {ScaleLine} from '../src/ol/control.js';
import {GeoJSON} from '../src/ol/format.js';
import LayerSwitcher from 'ol-ext/control/LayerSwitcher.js';
import GeoTIFF from '../src/ol/source/GeoTIFF.js';

// https://github.com/mattdesl/vec2-copy/blob/master/index.js
function vec2Copy(out, a) {
  out[0] = a[0]
  out[1] = a[1]
  return out
}

// https://github.com/Jam3/chaikin-smooth/blob/master/index.js
function chaikinSmooth (input, output) {
  if (!Array.isArray(output))
    output = []

  if (input.length>0)
    output.push(vec2Copy([0, 0], input[0]))
  for (let i=0; i<input.length-1; i++) {
    const p0 = input[i];
    const p1 = input[i + 1];
    const p0x = p0[0],
      p0y = p0[1],
      p1x = p1[0],
      p1y = p1[1];

    const Q = [0.75 * p0x + 0.25 * p1x, 0.75 * p0y + 0.25 * p1y];
    const R = [0.25 * p0x + 0.75 * p1x, 0.25 * p0y + 0.75 * p1y];
    output.push(Q)
    output.push(R)
  }
  if (input.length > 1)
    output.push(vec2Copy([0, 0], input[ input.length-1 ]))
  return output
}
function makeSmooth(path, numIterations) {
  numIterations = Math.min(Math.max(numIterations, 1), 10);
  while (numIterations > 0) {
    path = chaikinSmooth(path);
    numIterations--;
  }
  return path;
}

//todo: select existing centerLine feature from PTCL json, click to convert to nodes+lanes format
//todo: snap centerLine, adjust width automagically ?
//todo: last snapped feature, map.getFeaturesAtPixel is not easy to use, it has to be exact pixel
//todo: merge node
//todo: snap and trace ptcl.json centerline
//todo: copy and paste nodes
//todo: predefined shape, like extension loop
//todo: serialize out into proper file for ingestion into FMS
//todo: split pathSection into multiple pathSections if it is too long
//todo: trace on survey data, left hand side ?
const MaxLaneLengthMeters = 50;
const MaxLanePoints = 100;
let halfLaneWidthMeter = 8.5;
let modifyFmsLaneType = 'fmsNodes'
let controlType = 'add-nodes'
let modifyDelete = false
const xUnitVec = new p5.Vector(1, 0)

let params = (new URL(document.location)).searchParams;
let debug = params.get("debug") === 'true';
let copyFmsNodesFromPtclJson = params.get("copyFmsNodesFromPtclJson") === 'true';
let bezierSteps = 4;
const FmsProjection = 'EPSG:28350'

let fmsMap = localStorage.getItem('fmsMap') ? JSON.parse(localStorage.getItem('fmsMap')) : {
  units: {
    length: 'meters',
    angle: 'radians',
    projection: FmsProjection,
  },
  fmsNodes: [],
  fmsLaneSections: [],
};

let fmsNodes = fmsMap.fmsNodes;
let fmsLaneSections = fmsMap.fmsLaneSections;

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

  const midPointIx = Math.floor(centerLine.getCoordinates().length / 2) + 1
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


// MGRS:50KQA
var MGRS50KQA = 'PROJCS["GDA94 / Custom",' +
  'GEOGCS["GDA94",' +
  '    DATUM["Geocentric_Datum_of_Australia_1994",' +
  '        SPHEROID["GRS 1980",6378137,298.257222101],' +
  '        TOWGS84[0,0,0,0,0,0,0]],' +
  '    PRIMEM["Greenwich",0,' +
  '        AUTHORITY["EPSG","8901"]],' +
  '    UNIT["degree",0.0174532925199433,' +
  '        AUTHORITY["EPSG","9122"]],' +
  '    AUTHORITY["EPSG","4283"]],' +
  'PROJECTION["Transverse_Mercator"],' +
  'PARAMETER["latitude_of_origin",0],' +
  'PARAMETER["central_meridian",117],' +
  'PARAMETER["scale_factor",0.9996],' +
  'PARAMETER["false_easting",-200000],' +
  'PARAMETER["false_northing",2500000],' +
  'UNIT["metre",1,' +
  '    AUTHORITY["EPSG","9001"]],' +
  'AXIS["Easting",EAST],' +
  'AXIS["Northing",NORTH]]';
proj4.defs(
  "MGRS:50KQA",
  MGRS50KQA
);
register(proj4);

const geotiffLayer = new WebGLTileLayer();

const routeSource = new VectorSource({});
const routeLayer = new VectorLayer({
  name: 'Route Layer',
  source: routeSource,
  style: [new Style({
    stroke: new Stroke({
      color: 'red',
      width: 4
    }),
    image: new CircleStyle({
      radius: 4,
      fill: new Fill({
        color: 'red',
      })
    })
  })]
})
const addRoute = new Draw({
  source: routeSource,
  type: 'Point',
})


addRoute.on('drawend', function(evt) {
  const allFeatures = routeSource.getFeatures()
  for (let i = 0; i < allFeatures.length - 1; i++) {
    const feat = allFeatures[i]
    routeSource.removeFeature(feat);
  }
  if (allFeatures.length < 1) {
    return;
  }
  const sourcePoint = new Point(routeSource.getFeatures()[0].getGeometry().getCoordinates()).transform(FmsProjection, 'EPSG:4326');

  const destPoint = new Point(evt.feature.getGeometry().getCoordinates()).transform(FmsProjection, 'EPSG:4326');
  setTimeout(() => {
    const valhallaUrl = 'http://localhost:8002/route?json='
    const payload = {
      "locations": [
        {
          "options": {
            "allowUTurn": true
          },
          "latLng": {
            "lat": sourcePoint.getCoordinates()[1],
            "lng": sourcePoint.getCoordinates()[0]
          },
          "_initHooksCalled": true,
          "lat": sourcePoint.getCoordinates()[1],
          "lon": sourcePoint.getCoordinates()[0]
        },
        {
          "options": {
            "allowUTurn": true
          },
          "latLng": {
            "lat": destPoint.getCoordinates()[1],
            "lng": destPoint.getCoordinates()[0]
          },
          "_initHooksCalled": true,
          "lat": destPoint.getCoordinates()[1],
          "lon": destPoint.getCoordinates()[0]
        }
      ],
      "costing": "truck",
      "costing_options2": {
        "length": 500
      }
    }

    fetch(valhallaUrl + JSON.stringify(payload))
      .then(res => res.json())
      .then(json => {
        console.log(json)
        // https://github.com/tim-field/lrm-valhalla/blob/master/src/L.Routing.Valhalla.js#L100

        const insts = [];
        const coordinates = [];
        let shapeIndex = 0;

        const manueversInstruction = []

        for(let i = 0; i < json.trip.legs.length; i++){
          const coord = decodeValhallaShape(json.trip.legs[i].shape, 6);

          for(let k = 0; k < coord.length; k++){
            // convert to lon/lat (from lat/lon)
            const lonlatCoord = [ coord[k][1], coord[k][0] ];
            coordinates.push( lonlatCoord );
          }
          const lineString = new LineString(coordinates).transform('EPSG:4326', FmsProjection);
          const feature = new Feature({
            geometry: lineString,
          });
          routeSource.addFeature(feature);
          console.debug(coordinates, feature)

          // console.debug(coordinates)

          for(let j =0; j < json.trip.legs[i].maneuvers.length; j++) {
            const res = json.trip.legs[i].maneuvers[j];
            manueversInstruction.push(res.verbal_pre_transition_instruction);
            manueversInstruction.push(res.verbal_post_transition_instruction);
            res.distance = json.trip.legs[i].maneuvers[j]["length"];
            res.index = shapeIndex + json.trip.legs[i].maneuvers[j]["begin_shape_index"];
            insts.push(res);
          }

          shapeIndex += json.trip.legs[i].maneuvers[json.trip.legs[i].maneuvers.length-1]["begin_shape_index"];
        }

        overlay.setPosition(evt.feature.getGeometry().getCoordinates())
        const innerHTML = `
        <code>
          <pre>${JSON.stringify(manueversInstruction, null, 2)}</pre>
        </code>    `

        content.innerHTML = innerHTML;

      }).catch(err => {
        console.error(err)
      })

  }, 0)
})

const decodeValhallaShape = function(str, precision) {
  var index = 0,
    lat = 0,
    lng = 0,
    coordinates = [],
    shift = 0,
    result = 0,
    byte = null,
    latitude_change,
    longitude_change,
    factor = Math.pow(10, precision || 6);

  // Coordinates have variable length when encoded, so just keep
  // track of whether we've hit the end of the string. In each
  // loop iteration, a single coordinate is decoded.
  while (index < str.length) {

    // Reset shift, result, and byte
    byte = null;
    shift = 0;
    result = 0;

    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));

    shift = result = 0;

    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));

    lat += latitude_change;
    lng += longitude_change;

    coordinates.push([lat / factor, lng / factor]);
  }

  return coordinates;
}

const surveySource = new VectorSource({});
const surveyLayer = new VectorLayer({
  name: 'Flinders Survey Layer',
  source: surveySource,
  style: [new Style({
    stroke: new Stroke({
      color: 'yellow',
      width: 2
    })
  })]
})
surveyLayer.setVisible(false)
const surveySnap = new Snap({
  source: surveySource,
})

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

const testSource = new VectorSource();
const testLayer = new VectorLayer({
  name: 'Test Layer',
  source: testSource,
})
const testSource2 = new VectorSource();
const testLayer2 = new VectorLayer({
  name: 'Test Layer 2',
  source: testSource2,
  style: new Style({
    stroke: new Stroke({
      color: 'red',
      width: 2,
    })
  })
})
const centerLineSource = new VectorSource();
const centerLineLayer = new VectorLayer({
  name: 'Center Line Layer',
  source: centerLineSource,
  style: getDirectionArrowStyle
});
const ribsSource = new VectorSource();
const ribsLayer = new VectorLayer({
  name: 'Ribs Layer',
  source: ribsSource,
});
const boundarySource = new VectorSource();
const boundaryLayer = new VectorLayer({
  name: 'Boundary Layer',
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

//todo: is this used?
const drawSource = new VectorSource();
const newVector = new VectorLayer({
  name: 'Draw Layer',
  source: drawSource,
  style: getRibsRotationStyle
});

const fmsNodesSource = new VectorSource();
const fmsNodesLayer = new VectorLayer({
  name: 'FMS Nodes Layer',
  source: fmsNodesSource,
  // style: getRibsRotationStyle
});

const nodeConnectorsSource = new VectorSource();
const nodeConnectorsLayer = new VectorLayer({
  name: 'Node Connectors Layer',
  source: nodeConnectorsSource,
});

const addLaneSectionSource = new VectorSource();
// use when drawing initial linestring between nodes
const addLaneSectionLayer = new VectorLayer({
  name: 'Add Lane Section Temp Layer',
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
//     dataProjection: FmsProjection,
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
    dataProjection: FmsProjection,
    // featureProjection: 'EPSG:3857',
    featureProjection: FmsProjection,
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
      fmsNodes: fmsNodesLayer
    }
  }),
  overlaps: false,
});

// const ptclSource = new VectorSource({
//   url: 'flying_fish_original_ptcl_1.ptcl.json',
//   format: new PtclJSON({
//     dataProjection: FmsProjection,
//     style: defaultStyle,
//     mgrsSquare: {
//       utm_zone: 50,
//       lat_band: 'K',
//       column: 'M',
//       row: 'A',
//     },
//     layers: {
//       boundary: boundaryLayer,
//       centerLine: centerLineLayer,
//       ribs: ribsLayer,
//     }
//   }),
//   overlaps: false,
// });

const vectorPtcl = new VectorLayer({
  name: 'PTCL Layer',
  source: ptclSource,
  style: defaultStyle,
});
vectorPtcl.setVisible(true)

const bing = new TileLayer({
  name: 'Bing Maps',
  visible: false,
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

const scaleBarControl = new ScaleLine({
  units: 'metric',
  bar: true,
  steps: 4,
  text: true,
  minWidth: 140,
});

const map = new Map({
  controls: defaultControls().extend([scaleBarControl]),
  layers: [
    /*bing,*/ geotiffLayer,
    surveyLayer,
    vectorPtcl, newVector, fmsNodesLayer, addLaneSectionLayer,
    ribsLayer, centerLineLayer, boundaryLayer, nodeConnectorsLayer,
    testLayer, testLayer2,
    routeLayer,
  ],
  overlays: [overlay],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 2,
    projection: FmsProjection,
  }),
});

window.mapObject = map

var ctrl = new LayerSwitcher({
  // collapsed: false,
  // mouseover: true
});
map.addControl(ctrl);
ctrl.on('toggle', function(e) {
  console.log('Collapse layerswitcher', e.collapsed);
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

  if (copyFmsNodesFromPtclJson) {
    // fmsPtclJsonPathSections = ptclSource.getFormat().getFmsPathSections()
    const fmsNodesPtclJson = ptclSource.getFormat().getFmsNodes()
    fmsNodes.push(...fmsNodesPtclJson)
  }

  const mapView = map.getView()
  mapView.fit(feature.getGeometry().getExtent());
  // mapView.setZoom(mapView.getZoom() - 4)
  firstLoad = true;

  recreateFmsMap()
  fetch('flinders_survey.json')
    .then(res => res.json())
    .then(json => {
      const format = new GeoJSON()
      const features = format.readFeatures(json, {
        featureProjection: FmsProjection,
        dataProjection: 'EPSG:4326'
      })
      surveySource.addFeatures(features)
    })

  setTimeout(() => {


    fetch('flinders_radar_cog.tif')
      .then((response) => response.blob())
      .then((blob) => {
        const source = new GeoTIFF({
          sources: [
            {
              blob,
            },
          ],
          projection: 'MGRS:50KQA'
        });
window.geotiffSource = source
        geotiffLayer.setSource(source);
        setTimeout(() => {
          console.log(source.tileGrid.getExtent())

          // mapView.fit(source.tileGrid.getExtent());
        }, 1000);
        // mapView.setZoom(mapView.getZoom() - 4)
        console.log('source', source)
      });
  }, 1110)


});

const updateFmsNode = () => {
  const fmsNodeId = document.getElementById('fms-node-id').value;
  const fmsNode = fmsNodes.find(fmsNode => fmsNode.id === fmsNodeId)
  const referenceHeadingDegree = document.getElementById('fms-node-heading').value;
  const nodeWidth = document.getElementById('fms-node-width').value;

  fmsNode.referenceHeading = toRadians(referenceHeadingDegree);
  fmsNode.leftEdge.distanceFromReferencePoint = nodeWidth / 2;
  fmsNode.rightEdge.distanceFromReferencePoint = nodeWidth / 2;
  redrawFmsNodes(fmsNodeId)
}
window.updateFmsNode = updateFmsNode.bind(this);

const deleteFmsNode = () => {
  const fmsNodeId = document.getElementById('fms-node-id').value;
  const idx = fmsNodes.findIndex(fmsNode => fmsNode.id === fmsNodeId)
  if (idx === -1) {
    throw new Error('fms node not found')
  }
  fmsNodes.splice(idx, 1)

  const fmsNodeFeature = fmsNodesSource.getFeatures().find(feat => feat.get('fmsNodeId') === fmsNodeId)
  fmsNodesSource.removeFeature(fmsNodeFeature)

  const connectorHeadingSame = nodeConnectorsSource.getFeatures().find(feat => feat.get('fmsNodeId') === fmsNodeId && feat.get('fmsNodeConnectorHeading') === 'same')
  nodeConnectorsSource.removeFeature(connectorHeadingSame)

  const connectorHeadingOpposite = nodeConnectorsSource.getFeatures().find(feat => feat.get('fmsNodeId') === fmsNodeId && feat.get('fmsNodeConnectorHeading') === 'opposite')
  nodeConnectorsSource.removeFeature(connectorHeadingOpposite)

  for (let i = fmsLaneSections.length - 1; i >= 0 ; i--) {
    const fmsLaneSection = fmsLaneSections[i];
    if (fmsLaneSection.startFmsNodeId === fmsNodeId || fmsLaneSection.endFmsNodeId === fmsNodeId) {
      fmsLaneSections.splice(i, 1)
      const centerLineToDelete = centerLineSource.getFeatures().find(feat => feat.get('fmsLaneSectionId') === fmsLaneSection.id)
      centerLineSource.removeFeature(centerLineToDelete)
      const ribsToDelete = ribsSource.getFeatures().find(feat => feat.get('fmsLaneSectionId') === fmsLaneSection.id)
      ribsSource.removeFeature(ribsToDelete)
      const boundaryToDelete = boundarySource.getFeatures().find(feat => feat.get('fmsLaneSectionId') === fmsLaneSection.id)
      boundarySource.removeFeature(boundaryToDelete)
    }
  }
  redrawAllFmsLaneSections()
}
window.deleteFmsNode = deleteFmsNode.bind(this);

const setFmsLaneSectionWeights = () => {
  const fmsLaneSectionId = document.getElementById('fms-lane-section-id').value;
  const startWeight = document.getElementById('fms-lane-section-start-weight').value;
  const startWeightHeading = document.getElementById('fms-lane-section-start-weight-heading').value;
  const endWeight = document.getElementById('fms-lane-section-end-weight').value;
  const endWeightHeading = document.getElementById('fms-lane-section-end-weight-heading').value;
  const bezierSteps = document.getElementById('fms-lane-section-bezier-steps').value;
  const fmsLaneSection = fmsLaneSections.find(fmsLaneSection => fmsLaneSection.id === fmsLaneSectionId);
  fmsLaneSection.startWeight = parseFloat(startWeight);
  fmsLaneSection.startWeightHeading = toRadians(parseFloat(startWeightHeading));
  fmsLaneSection.endWeight = parseFloat(endWeight);
  fmsLaneSection.endWeightHeading = toRadians(parseFloat(endWeightHeading));
  fmsLaneSection.bezierSteps = parseInt(bezierSteps);

  redrawFmsLaneSections(fmsLaneSectionId)
}
window.updateFmsLaneSection = setFmsLaneSectionWeights.bind(this);

const deleteFmsLaneSection = () => {
  if(window.confirm("Delete lane section?")) {
    const fmsLaneSectionId = document.getElementById('fms-lane-section-id').value;
    const fmsLaneSectionIx = fmsLaneSections.findIndex(fmsLaneSection => fmsLaneSection.id === fmsLaneSectionId);

    fmsLaneSections.splice(fmsLaneSectionIx, 1);

    const centerLineFeature = centerLineSource.getFeatures().find(feat => feat.get('fmsLaneSectionId') === fmsLaneSectionId)
    centerLineSource.removeFeature(centerLineFeature);

    const ribsFeature = ribsSource.getFeatures().find(feat => feat.get('fmsLaneSectionId') === fmsLaneSectionId)
    ribsSource.removeFeature(ribsFeature);

    const boundaryFeature = boundarySource.getFeatures().find(feat => feat.get('fmsLaneSectionId') === fmsLaneSectionId)
    boundarySource.removeFeature(boundaryFeature);

    fmsNodes.forEach(fmsNode => {
      if(fmsNode.nextSectionsId.includes(fmsLaneSectionId)) {
        fmsNode.nextSectionsId.splice(fmsNode.nextSectionsId.indexOf(fmsLaneSectionId), 1)
      }
      if(fmsNode.prevSectionsId.includes(fmsLaneSectionId)) {
        fmsNode.prevSectionsId.splice(fmsNode.prevSectionsId.indexOf(fmsLaneSectionId), 1)
      }
    })
    console.log(fmsNodes)
  }
}
window.deleteFmsLaneSection = deleteFmsLaneSection.bind(this);

const makeBidirectionalInternal = (fmsLaneSectionId) => {
  const fmsLaneSection = fmsLaneSections.find(fmsLaneSection => fmsLaneSection.id === fmsLaneSectionId)
  const reversedFmsLaneSection = {
    id: uuidv4(),
    startFmsNodeId: fmsLaneSection.endFmsNodeId,
    startFmsNodeConnectorHeading: fmsLaneSection.endFmsNodeConnectorHeading,
    startWeight: fmsLaneSection.endWeight,
    startWeightHeading: fmsLaneSection.endWeightHeading,

    endFmsNodeId: fmsLaneSection.startFmsNodeId,
    endFmsNodeConnectorHeading: fmsLaneSection.startFmsNodeConnectorHeading,
    endWeight: fmsLaneSection.startWeight,
    endWeightHeading: fmsLaneSection.startWeightHeading,
    bezierSteps: fmsLaneSection.bezierSteps,
  }
  fmsLaneSections.push(reversedFmsLaneSection)
  const startFmsNode = fmsNodes.find(fmsNode => fmsNode.id === reversedFmsLaneSection.startFmsNodeId)
  startFmsNode.nextSectionsId.push(reversedFmsLaneSection.id)
  const endFmsNode = fmsNodes.find(fmsNode => fmsNode.id === reversedFmsLaneSection.endFmsNodeId)
  endFmsNode.prevSectionsId.push(reversedFmsLaneSection.id)

  const centerLineFeature = new Feature({
    fmsLaneSectionId: reversedFmsLaneSection.id,
  })
  centerLineSource.addFeature(centerLineFeature)

  const ribsFeature = new Feature({
    fmsLaneSectionId: reversedFmsLaneSection.id,
  })
  ribsSource.addFeature(ribsFeature)

  const boundaryFeature = new Feature({
    fmsLaneSectionId: reversedFmsLaneSection.id,
  })
  boundarySource.addFeature(boundaryFeature)
  redrawFmsLaneSections(reversedFmsLaneSection.id)
}
window.makeBidirectionalInternal = makeBidirectionalInternal.bind(this);
window.makeBidirectional = () => {
  const fmsLaneSectionId = document.getElementById('fms-lane-section-id').value;
  makeBidirectionalInternal(fmsLaneSectionId);
}

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
      <p>Rotation (degree from east):
        <input id='fms-node-heading' type='text' size='5' value='${toDegrees(fmsNode.referenceHeading)}'></p>
      <p>Width:
        <input type='text' id='fms-node-width' size='5'
          value='${fmsNode.leftEdge.distanceFromReferencePoint + fmsNode.rightEdge.distanceFromReferencePoint}'
      </p>
      <p>Prev Sections: ${fmsNode.prevSectionsId.join(",")} </p>
      <button onclick="window.updateFmsNode()">Set</button>
      <button onclick="window.deleteFmsNode()">Delete</button>
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
      <p>Start Weight: <input id='fms-lane-section-start-weight' type='text' size='5' value='${fmsLaneSection.startWeight}'></p>
      <p>Start Weight Heading: <input id='fms-lane-section-start-weight-heading' type='text' size='5' value='${toDegrees(fmsLaneSection.startWeightHeading)}'></p>
      <p>End Weight: <input id='fms-lane-section-end-weight' type='text' size='5' value='${fmsLaneSection.endWeight}'></p>
      <p>End Weight Heading: <input id='fms-lane-section-end-weight-heading' type='text' size='5' value='${toDegrees(fmsLaneSection.endWeightHeading)}'></p>
      <p>Bezier Steps: <input id='fms-lane-section-bezier-steps' type='text' size='5' value='${fmsLaneSection.bezierSteps}'></p>

      <button onclick='window.updateFmsLaneSection()'>Set</button>
      <button onclick='window.deleteFmsLaneSection()'>Delete</button>
      <button onclick='window.makeBidirectional()'>Make Bidirectional</button>
    </div>`

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
});
let centerLineSnap = new Snap({
  source: centerLineSource,
});
centerLineSnap.on('snap', (e) => {
  // console.log('centerLineSnap', e)
})
let addNodesSnap = new Snap({
  source: fmsNodesSource,
});
let nodeConnectorsSnap = new Snap({
  source: nodeConnectorsSource,
})

let modifyFmsNodes;
const select = new Select({multi: true});
// select feature first and then modifyRibs selected features
select.on('select', function (e) {
  const selected = select.getFeatures()
  const featuresToModify = new Collection()

  selected.forEach(feat => {
    console.log(feat.get('fmsLaneType'), modifyFmsLaneType)

    if(feat.get('fmsLaneType') === modifyFmsLaneType) {
      featuresToModify.push(feat)
    }
  })
  selected.clear();
  console.log(featuresToModify)
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

/**
 * Node Connectors are two circles on left and right of a Node, used to connect two nodes to form a lane section
 * @param fmsNode
 * @returns {{sameHeadingGeom: Point, oppositeHeadingGeom: Point}}
 */
const createNodeConnectorGeom = (fmsNode) => {
  let center = new p5.Vector(fmsNode.referencePoint.x, fmsNode.referencePoint.y)
  let directionNorm = p5.Vector.rotate(xUnitVec, fmsNode.referenceHeading)
  const selectorDistance = 5
  const sameHeadingPoint = p5.Vector.add(center, p5.Vector.mult(directionNorm, selectorDistance))
  const sameHeadingGeom = new Point([sameHeadingPoint.x, sameHeadingPoint.y])

  const oppositeHeadingPoint = p5.Vector.sub(center, p5.Vector.mult(directionNorm, selectorDistance))
  const oppositeHeadingGeom = new Point([oppositeHeadingPoint.x, oppositeHeadingPoint.y])
  return {
    sameHeadingGeom, oppositeHeadingGeom
  }
}

const recreateFmsMap = () => {
  console.log(fmsMap.units.projection, map.getView().getProjection().getCode())
  // create fmsNode feature
  fmsNodes.forEach(fmsNode => {
    if (fmsMap.units.projection !== map.getView().getProjection().getCode()) {
      const fmsNodeRefPoint = new Point([fmsNode.referencePoint.x, fmsNode.referencePoint.y]).transform(fmsMap.units.projection, map.getView().getProjection().getCode()).getCoordinates()
      fmsNode.referencePoint.x = fmsNodeRefPoint[0]
      fmsNode.referencePoint.y = fmsNodeRefPoint[1]
    }

    const fmsNodeGeomCol = getFmsNodesGeomCol(fmsNode)
    const fmsNodeFeature = new Feature({
      geometry: fmsNodeGeomCol,
      fmsNodeId: fmsNode.id,
      fmsLaneType: 'fmsNode',
      fmsNode: fmsNode
    })
    fmsNodesSource.addFeature(fmsNodeFeature)

    createFmsNodesConnectorFeatures(fmsNode)
  });

  fmsLaneSections.forEach(fmsLaneSection => createFmsLaneSectionsFeatures(fmsLaneSection));
}

const createFmsNodesConnectorFeatures = (fmsNode) => {
  const { sameHeadingGeom, oppositeHeadingGeom } = createNodeConnectorGeom(fmsNode)
  const sameHeadingFeature = new Feature(sameHeadingGeom)
  sameHeadingFeature.set('fmsNodeId', fmsNode.id)
  sameHeadingFeature.set('fmsLaneType', 'connector')
  sameHeadingFeature.set('fmsNodeConnectorHeading', 'same')
  nodeConnectorsSource.addFeature(sameHeadingFeature)

  const oppositeHeadingFeature = new Feature(oppositeHeadingGeom)
  oppositeHeadingFeature.set('fmsNodeId', fmsNode.id)
  oppositeHeadingFeature.set('fmsLaneType', 'connector')
  oppositeHeadingFeature.set('fmsNodeConnectorHeading', 'opposite')
  nodeConnectorsSource.addFeature(oppositeHeadingFeature)
}

const createFmsLaneSectionsFeatures = (fmsLaneSection) => {
  const fmsLaneSectionId = fmsLaneSection.id
  const centerLineGeom = createBezierCenterLineGeom(fmsLaneSection)
  const centerLineFeature = new Feature({
    geometry: centerLineGeom,
  })
  centerLineFeature.set('fmsLaneType', 'centerLine')
  centerLineFeature.set('fmsLaneSectionId', fmsLaneSectionId)
  centerLineFeature.set('fmsLaneSection', fmsLaneSection)
  centerLineSource.addFeature(centerLineFeature)

  const centerLineCoords = centerLineGeom.getCoordinates();

  const ribsBoundaryGeomObj = calculateRibsAndBoundaryGeom(fmsLaneSection, centerLineCoords);
  fmsLaneSection.sectionBoundaries = ribsBoundaryGeomObj.sectionBoundaries
  const ribsGeom = ribsBoundaryGeomObj.ribsGeom
  const ribsFeature = new Feature({
    geometry: ribsGeom
  })
  ribsFeature.set('fmsLaneType', 'ribs')
  ribsFeature.set('fmsLaneSectionId', fmsLaneSectionId)
  ribsFeature.set('fmsLaneSection', fmsLaneSection)
  ribsSource.addFeature(ribsFeature)

  const boundaryGeom = ribsBoundaryGeomObj.boundaryGeom
  const boundaryFeature = new Feature({
    geometry: boundaryGeom
  })
  boundaryFeature.set('fmsLaneType', 'boundary')
  boundaryFeature.set('fmsLaneSectionId', fmsLaneSectionId)
  boundaryFeature.set('fmsLaneSection', fmsLaneSection)
  boundarySource.addFeature(boundaryFeature)
}

const redrawFmsNodes = (fmsNodeId) => {
  const fmsNode = fmsNodes.find(fmsNode => fmsNode.id === fmsNodeId)
  const fmsNodeFeature = fmsNodesSource.getFeatures().find(feat => feat.get('fmsNodeId') === fmsNodeId)
  const fmsNodeGeomCol = getFmsNodesGeomCol(fmsNode)
  fmsNodeFeature.setGeometry(fmsNodeGeomCol)

  const { sameHeadingGeom, oppositeHeadingGeom } = createNodeConnectorGeom(fmsNode)

  const connectorHeadingSame = nodeConnectorsSource.getFeatures().find(feat => feat.get('fmsNodeId') === fmsNodeId && feat.get('fmsNodeConnectorHeading') === 'same')
  connectorHeadingSame.setGeometry(sameHeadingGeom)

  const connectorHeadingOpposite = nodeConnectorsSource.getFeatures().find(feat => feat.get('fmsNodeId') === fmsNodeId && feat.get('fmsNodeConnectorHeading') === 'opposite')
  connectorHeadingOpposite.setGeometry(oppositeHeadingGeom)

  fmsNode.prevSectionsId.forEach(prevSectionId => {
    redrawFmsLaneSections(prevSectionId)
  })
  fmsNode.nextSectionsId.forEach(nextSectionId => {
    redrawFmsLaneSections(nextSectionId)
  })
}

const redrawAllFmsLaneSections = () => {
  fmsLaneSections.forEach(fmsLaneSection => {
    redrawFmsLaneSections(fmsLaneSection.id)
  })
}

const createBezierCenterLineGeom = (fmsLaneSection) => {
  const startFmsNode = fmsNodes.find(node => node.id === fmsLaneSection.startFmsNodeId)
  const startFmsNodeConnectorHeading = fmsLaneSection.startFmsNodeConnectorHeading
  const endFmsNode = fmsNodes.find(node => node.id === fmsLaneSection.endFmsNodeId)
  const endFmsNodeConnectorHeading = fmsLaneSection.endFmsNodeConnectorHeading
  const bezierPt1 = startFmsNode.referencePoint
  const pt2 = new p5.Vector(startFmsNode.referencePoint.x, startFmsNode.referencePoint.y)
  let bezierPt2;
  if (startFmsNodeConnectorHeading === 'same') {
    let pt2direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
    let pt2direction2 = p5.Vector.rotate(pt2direction, fmsLaneSection.startWeightHeading)
    const pt2startWeight = p5.Vector.mult(pt2direction2, fmsLaneSection.startWeight)
    bezierPt2 = p5.Vector.add(pt2, pt2startWeight)
  } else if (startFmsNodeConnectorHeading === 'opposite') {
    const pt2direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading + Math.PI)
    // todo: check this calc
    let pt2direction2 = p5.Vector.rotate(pt2direction, fmsLaneSection.startWeightHeading)
    const pt2startWeight = p5.Vector.mult(pt2direction2, fmsLaneSection.startWeight)
    bezierPt2 = p5.Vector.add(pt2, pt2startWeight)
  }

  const pt3 = new p5.Vector(endFmsNode.referencePoint.x, endFmsNode.referencePoint.y)
  let bezierPt3;
  if (endFmsNodeConnectorHeading === 'same') {
    const pt3direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading + Math.PI)
    // todo: check this calc
    const pt3direction2 = p5.Vector.rotate(pt3direction, fmsLaneSection.endWeightHeading)
    const pt3endWeight = p5.Vector.mult(pt3direction2, fmsLaneSection.endWeight)

    bezierPt3 = p5.Vector.sub(pt3, pt3endWeight)
  }
  else if (endFmsNodeConnectorHeading === 'opposite') {
    const pt3direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
    // todo: check this calc
    const pt3direction2 = p5.Vector.rotate(pt3direction, fmsLaneSection.endWeightHeading)
    const pt3endWeight = p5.Vector.mult(pt3direction2, fmsLaneSection.endWeight)
    bezierPt3 = p5.Vector.sub(pt3, pt3endWeight)
  }

  const bezierPt4 = endFmsNode.referencePoint

  const centerLineBezier = new Bezier(
    bezierPt1.x, bezierPt1.y,
    bezierPt2.x, bezierPt2.y,
    bezierPt3.x, bezierPt3.y,
    bezierPt4.x, bezierPt4.y);

  const luts = centerLineBezier.getLUT(fmsLaneSection.bezierSteps).map(lut => [lut.x, lut.y])

  return new LineString(luts)
}

const isEqualWithTolerance = (a, b) => {
  const tolerance = 1e-7;
  return Math.abs(a - b) < tolerance
}

const calculateRibsAndBoundaryGeom = (fmsLaneSection, centerLineCoords) => {
  const startFmsNode =  fmsNodes.find(node => node.id === fmsLaneSection.startFmsNodeId)
  const startFmsNodeConnectorHeading = fmsLaneSection.startFmsNodeConnectorHeading
  const endFmsNode = fmsNodes.find(node => node.id === fmsLaneSection.endFmsNodeId)
  const endFmsNodeConnectorHeading = fmsLaneSection.endFmsNodeConnectorHeading
  const sectionBoundaries = []

  const startFmsNodeWidth = startFmsNode.leftEdge.distanceFromReferencePoint + startFmsNode.rightEdge.distanceFromReferencePoint
  const endFmsNodeWidth = endFmsNode.leftEdge.distanceFromReferencePoint + endFmsNode.rightEdge.distanceFromReferencePoint

  let edgeDistanceDelta = 0
  if (!isEqualWithTolerance(startFmsNodeWidth, endFmsNodeWidth)) {
    // if endFmsNodeWidth is greater than startFmsNodeWidth, then edgeDistanceDelta will be positive
    edgeDistanceDelta = (endFmsNodeWidth - startFmsNodeWidth) / centerLineCoords.length
  }

  // rib 0 uses startFmsNode heading, last rib uses endFmsNode heading
  // for everything in between, it's calculated from currentCoord - prevCoord
  for (let i = 1; i < centerLineCoords.length; i++) {
    const curCoord = centerLineCoords[i]
    const prevCoord = centerLineCoords[i-1]
    let prev = new p5.Vector(prevCoord[0], prevCoord[1]);
    let cur = new p5.Vector(curCoord[0], curCoord[1])
    let direction = p5.Vector.sub(cur, prev)

    let startOrEndDirection;
    //todo: refactor drawRibsRotation style to use this
    if (i === 1) {
      if (startFmsNodeConnectorHeading === 'same') {
        startOrEndDirection = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
      }
      else {
        startOrEndDirection = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading + Math.PI)
      }
    }
    else if(i === centerLineCoords.length - 1) {
      if (endFmsNodeConnectorHeading === 'same') {
        startOrEndDirection = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading + Math.PI)
      }
      else {
        startOrEndDirection = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
      }
    }

    const halfWidth = startFmsNodeWidth / 2 + edgeDistanceDelta / 2 * (i - 1);

    if (i === 1) {
      // first rib
      let sectionBoundary = {
        order: i-1,
        referencePoint: {x: prevCoord[0], y: prevCoord[1]},
        referenceHeading: startOrEndDirection.heading(),
        leftEdge: {
          distanceFromReferencePoint: halfWidth
        },
        rightEdge: {
          distanceFromReferencePoint: halfWidth,
        }
      }
      sectionBoundaries.push(sectionBoundary);
    }
    else if (i === centerLineCoords.length - 1) {
      let secondLasPathSectionElement = {
        order: i-1,
        referencePoint: { x: prevCoord[0], y: prevCoord[1] },
        referenceHeading: direction.heading(),
        leftEdge: {
          distanceFromReferencePoint: halfWidth,
        },
        rightEdge: {
          distanceFromReferencePoint: halfWidth,
        }
      }
      sectionBoundaries.push(secondLasPathSectionElement);

      // add last rib, at endFmsNode, must match endFmsNode heading and width
      let lastPathSectionElement = {
        order: i,
        referencePoint: { x: curCoord[0], y: curCoord[1] },
        referenceHeading: startOrEndDirection.heading(),
        leftEdge: {
          distanceFromReferencePoint: endFmsNodeWidth / 2,
        },
        rightEdge: {
          distanceFromReferencePoint: endFmsNodeWidth / 2,
        }
      }
      sectionBoundaries.push(lastPathSectionElement);
    } else {
      let pathSectionElement = {
        order: i-1,
        referencePoint: { x: prevCoord[0], y: prevCoord[1] },
        referenceHeading: direction.heading(),
        leftEdge: {
          distanceFromReferencePoint: halfWidth,
        },
        rightEdge: {
          distanceFromReferencePoint: halfWidth,
        }
      }
      sectionBoundaries.push(pathSectionElement);
    }
  }

  const ribsCoords = []
  for (let i = 0; i < sectionBoundaries.length; i++) {
    const sectionBoundary = sectionBoundaries[i]
    const ribCoords = PtclJSON.calcRibsCoordsInMapProjection(sectionBoundary)
    ribsCoords.push(ribCoords)
  }
  const ribsGeom = PtclJSON.ribsToMultiLineString(ribsCoords)
  const boundaryGeom = PtclJSON.getBoundaryGeom(ribsCoords)

  return { ribsGeom, boundaryGeom, sectionBoundaries }
}

const redrawFmsLaneSections = (fmsLaneSectionId) => {
  const fmsLaneSection = fmsLaneSections.find(fmsLaneSection => fmsLaneSection.id === fmsLaneSectionId)

  const centerLine = createBezierCenterLineGeom(fmsLaneSection)
  centerLineSource.getFeatures().find(feat => feat.get('fmsLaneSectionId') === fmsLaneSectionId).setGeometry(centerLine)

  const centerLineCoords = centerLine.getCoordinates();

  const ribsBoundaryGeomObj = calculateRibsAndBoundaryGeom(fmsLaneSection, centerLineCoords);
  fmsLaneSection.sectionBoundaries = ribsBoundaryGeomObj.sectionBoundaries
  const ribsGeom = ribsBoundaryGeomObj.ribsGeom
  const boundaryGeom = ribsBoundaryGeomObj.boundaryGeom
  ribsSource.getFeatures().find(feat => feat.get('fmsLaneSectionId') === fmsLaneSectionId).setGeometry(ribsGeom)
  boundarySource.getFeatures().find(feat => feat.get('fmsLaneSectionId') === fmsLaneSectionId).setGeometry(boundaryGeom)
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

  return geometry;
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

const addNodes = new Draw({
  type: 'Point',
  source: fmsNodesSource,
  geometryFunction: addNodesGeomFn,
  style: getNodesStyle
})

addNodes.on('drawend', function(evt) {
  const fmsNode = evt.feature.getGeometry().get('fmsNode')
  //todo: delete fmsNode in evt.feature.getGeometry().get('fmsNode') ?
  evt.feature.set('fmsNodeId', fmsNode.id)
  evt.feature.set('fmsNode', fmsNode)
  evt.feature.set('fmsLaneType', 'fmsNode')

  createFmsNodesConnectorFeatures(fmsNode)
})

let useFreehand = false;
let addNodesAndLanesDraw = new Draw({
  type: 'LineString',
  source: testSource,
  freehand: useFreehand,
  trace: true,
  traceSource: surveySource
})
// onchange event for use-freehand checkbox
const useFreehandCheckbox = document.getElementById('use-freehand');
useFreehandCheckbox.onchange = function() {
  useFreehand = this.checked;
  map.removeInteraction(addNodesAndLanesDraw)
  map.removeInteraction(nodeConnectorsSnap)
  map.removeInteraction(snap);
  map.removeInteraction(ptclSnap);
  map.removeInteraction(centerLineSnap)
  map.removeInteraction(addNodesSnap)
  addNodesAndLanesDraw = new Draw({
    type: 'LineString',
    source: testSource,
    freehand: useFreehand,
    trace: true,
    traceSource: surveySource,
  })
  addNodesAndLanesDraw.on('drawend', addNodesAndLanesDrawEndHandler)
  map.addInteraction(addNodesAndLanesDraw)
  map.addInteraction(nodeConnectorsSnap)
  map.addInteraction(snap);
  map.addInteraction(ptclSnap);
  map.addInteraction(centerLineSnap)
  map.addInteraction(addNodesSnap)

}
addNodesAndLanesDraw.on('drawstart', (evt) => {
  const snappedFmsNodeFeatures = map.getFeaturesAtPixel(evt.target.downPx_).filter(feat => feat.get('fmsLaneType') === 'connector');
  if (snappedFmsNodeFeatures.length === 0) {
    console.debug('no fmsNode found at drawstart')
    return;
  }
  console.log(snappedFmsNodeFeatures)
  const fmsNodeId = snappedFmsNodeFeatures[0].get('fmsNodeId')
  const fmsNodeConnectorHeading = snappedFmsNodeFeatures[0].get('fmsNodeConnectorHeading')

  evt.feature.set('startFmsNodeId', fmsNodeId)
  evt.feature.set('fmsNodeConnectorHeading', fmsNodeConnectorHeading)
})

const addNodesAndLanesDrawEndHandler = (evt) => {
  // only connection to existing fmsNode at start and end of drawn lanes are supported
  // (eg. no connection to existing fmsNode for nodes in middle of drawn lanes)
  const startFmsNodeId = evt.feature.get('startFmsNodeId')
  const startFmsNodeConnectorHeading = evt.feature.get('fmsNodeConnectorHeading')

  let endFmsNodeId;
  let endFmsNodeConnectorHeading;

  // using pointerPixelCoord: workaround for addNodesAndLanesDrawEndHandler evt.pixel not updated on drawend event and freehand is true
  const endFmsNodeFeatures = map.getFeaturesAtPixel(pointerPixelCoord).filter(feat => feat.get('fmsLaneType') === 'connector');

  if (endFmsNodeFeatures.length === 0) {
    console.debug('no fmsNode found at drawend, will create new fmsNode')
  }
  else {
    endFmsNodeId = endFmsNodeFeatures[0].get('fmsNodeId')
    endFmsNodeConnectorHeading = endFmsNodeFeatures[0].get('fmsNodeConnectorHeading')
    const tempEndFmsNode = fmsNodes.find(fmsNode => fmsNode.id === endFmsNodeId)
    console.debug('fmsNode found at drawend, will connect to existing fmsNode', endFmsNodeId, endFmsNodeConnectorHeading, tempEndFmsNode)
  }

  let coordinates = evt.feature.getGeometry().getCoordinates();
  const numIterations = 1;
  const smoothenedCoordinates = makeSmooth(coordinates, numIterations);

  if (debug) {
    const smoothenedLineString = new LineString(smoothenedCoordinates);
    const smoothenedFeature = new Feature({
      geometry: smoothenedLineString
    })
    testSource2.addFeature(smoothenedFeature)
  }

  coordinates = smoothenedCoordinates
  const error = 10
  // bezierCurves is an array of 4 points
  const bezierCurves = fitCurve(coordinates, error)
  const tempFmsNodes = [];
  //1. create fmsNodes from bezierCurves, and create fmsNode features
  for (let i = 0; i < bezierCurves.length; i++) {
    const bezierCurve = bezierCurves[i];

    const start = bezierCurve[0]
    const control1 = bezierCurve[1]
    const control2 = bezierCurve[2]
    const end = bezierCurve[3]

    const tempBezier = new Bezier(...start, ...control1, ...control2, ...end)
    const luts = tempBezier.getLUT(bezierSteps);
    let lut0 = new p5.Vector(luts[0].x, luts[0].y)
    let lut1 = new p5.Vector(luts[1].x, luts[1].y)

    let lut1Direction = p5.Vector.sub(lut1, lut0)
    let heading = xUnitVec.angleBetween(lut1Direction)

    const lutLast = new p5.Vector(
      luts[luts.length - 1].x,
      luts[luts.length - 1].y)
    const lutSecondLast = new p5.Vector(
      luts[luts.length - 2].x,
      luts[luts.length - 2].y)

    let lutLastDirection = p5.Vector.sub(lutLast, lutSecondLast)
    let headingLast = xUnitVec.angleBetween(lutLastDirection)

    if (i === 0 && startFmsNodeId != null) {
      const fmsNode = fmsNodes.find(node => node.id === startFmsNodeId)
      tempFmsNodes.push(fmsNode)
    } else {
      const fmsNode = {
        id: uuidv4(),
        referencePoint: {x: bezierCurve[0][0], y: bezierCurve[0][1]},
        referenceHeading: heading,
        leftEdge: {
          distanceFromReferencePoint: halfLaneWidthMeter,
        },
        rightEdge: {
          distanceFromReferencePoint: halfLaneWidthMeter,
        },
        nextSectionsId: [],
        prevSectionsId: []
      }

      tempFmsNodes.push(fmsNode)
    }

    if (i === bezierCurves.length - 1) {
      if (endFmsNodeId != null) {
        const fmsNode = fmsNodes.find(node => node.id === endFmsNodeId)
        tempFmsNodes.push(fmsNode)
      } else {
        // add last point of last bezier curve
        const fmsNode = {
          id: uuidv4(),
          referencePoint: {x: bezierCurve[3][0], y: bezierCurve[3][1]},
          referenceHeading: headingLast,
          leftEdge: {
            distanceFromReferencePoint: halfLaneWidthMeter,
          },
          rightEdge: {
            distanceFromReferencePoint: halfLaneWidthMeter,
          },
          nextSectionsId: [],
          prevSectionsId: []
        }
        tempFmsNodes.push(fmsNode)
      }
    }
  }
  tempFmsNodes.forEach(fmsNode => {
    if (fmsNodes.findIndex(node => node.id === fmsNode.id) === -1) {
      fmsNodes.push(fmsNode)
    }
  })
  // fmsNodes.push(...tempFmsNodes)
  //
  for (let i = 0; i < tempFmsNodes.length-1; i++) {
    const startFmsNode = tempFmsNodes[i];
    const endFmsNode = tempFmsNodes[i+1];

    const bezierCurve = bezierCurves[i];
    const start1 = new p5.Vector(bezierCurve[0][0], bezierCurve[0][1])
    const control1 = new p5.Vector(bezierCurve[1][0], bezierCurve[1][1])
    let startFmsNodeHeadingVector = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
    if (i === 0 && startFmsNodeConnectorHeading === 'opposite') {
      console.log('startFmsNodeConnectorHeading', startFmsNodeConnectorHeading, toDegrees(startFmsNode.referenceHeading))
      startFmsNodeHeadingVector = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading + Math.PI)
    }

    const startWeightVector = p5.Vector.sub(control1, start1)
    const startWeight = startWeightVector.mag()
    const startWeightHeading = startFmsNodeHeadingVector.angleBetween(startWeightVector)

    const control2 = new p5.Vector(bezierCurve[2][0], bezierCurve[2][1])
    const end1 = new p5.Vector(bezierCurve[3][0], bezierCurve[3][1])

    let endFmsNodeHeadingVector = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
    if (i === tempFmsNodes.length - 2 && endFmsNodeConnectorHeading === 'same') {
      console.log('endFmsNodeConnectorHeading', endFmsNodeConnectorHeading, toDegrees(endFmsNode.referenceHeading))
      endFmsNodeHeadingVector = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading + Math.PI)
    }

    const endWeightVector = p5.Vector.sub(end1, control2)
    const endWeight = endWeightVector.mag()
    const endWeightHeading = endFmsNodeHeadingVector.angleBetween(endWeightVector)

    const fmsLaneSection = {
      id: uuidv4(),
      startFmsNodeId: startFmsNode.id,
      startFmsNodeConnectorHeading: startFmsNodeConnectorHeading ? startFmsNodeConnectorHeading : 'same',
      endFmsNodeId: endFmsNode.id,
      endFmsNodeConnectorHeading: endFmsNodeConnectorHeading ? endFmsNodeConnectorHeading : 'opposite',
      startWeight: startWeight,
      startWeightHeading: startWeightHeading,
      endWeight: endWeight,
      endWeightHeading: endWeightHeading,
      bezierSteps
    }
    fmsLaneSections.push(fmsLaneSection)
    startFmsNode.nextSectionsId.push(fmsLaneSection.id)
    endFmsNode.prevSectionsId.push(fmsLaneSection.id)
  }

  //2. create fmsLaneSections from bezierCurves, and create fmsLaneSection features
  recreateFmsMap()

  if (!debug) {
    setTimeout(() => {
      testSource.removeFeature(evt.feature)
    }, 0)
  }
}

addNodesAndLanesDraw.on('drawend', addNodesAndLanesDrawEndHandler)

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
  style: getLaneSectionsStyle
})

addLaneSectionsDraw.on('drawstart', (evt) => {
  evt.feature.set('fmsLaneSectionId', uuidv4())
  evt.feature.set('fmsLaneType', 'pathSection')
  const snappedFmsNodeFeatures = map.getFeaturesAtPixel(evt.target.downPx_).filter(feat => feat.get('fmsLaneType') === 'connector');
  if (snappedFmsNodeFeatures.length === 0) {
    throw Error('no fmsNode found at drawstart')
  }
  console.log(snappedFmsNodeFeatures)
  const fmsNodeId = snappedFmsNodeFeatures[0].get('fmsNodeId')
  const fmsNodeConnectorHeading = snappedFmsNodeFeatures[0].get('fmsNodeConnectorHeading')

  evt.feature.set('startFmsNodeId', fmsNodeId)
  evt.feature.set('fmsNodeConnectorHeading', fmsNodeConnectorHeading)
});

addLaneSectionsDraw.on('drawend', (evt) => {
  const fmsLaneSectionId = evt.feature.get('fmsLaneSectionId')

  const endFmsNodeFeatures = map.getFeaturesAtPixel(evt.target.downPx_).filter(feat => feat.get('fmsLaneType') === 'connector');
  if (endFmsNodeFeatures.length === 0) {
    throw Error('no fmsNode found at drawend')
  }
  const fmsNodeId = endFmsNodeFeatures[0].get('fmsNodeId')
  const endFmsNode = fmsNodes.find(node => node.id === fmsNodeId)
  const endFmsNodeConnectorHeading = endFmsNodeFeatures[0].get('fmsNodeConnectorHeading')
  endFmsNode.prevSectionsId.push(fmsLaneSectionId)

  const startFmsNodeId = evt.feature.get('startFmsNodeId')
  const startFmsNode = fmsNodes.find(node => node.id === startFmsNodeId)
  const startFmsNodeConnectorHeading = evt.feature.get('fmsNodeConnectorHeading')
  startFmsNode.nextSectionsId.push(fmsLaneSectionId)

  const fmsLaneSection = {
    id: fmsLaneSectionId,
    startFmsNodeId: startFmsNode.id,
    startFmsNodeConnectorHeading,
    endFmsNodeId: endFmsNode.id,
    endFmsNodeConnectorHeading,
    startWeight: PathSectionStartWeightMeter,
    startWeightHeading: 0,
    endWeight: PathSectionEndWeightMeter,
    endWeightHeading: 0,
    bezierSteps
  }
  fmsLaneSections.push(fmsLaneSection)

  createFmsLaneSectionsFeatures(fmsLaneSection)

  setTimeout(() => {
    // remove drawn straight line from startNode to endNode, now bezier curve exists
    // todo: investigate how to remove without timeout
    addLaneSectionSource.removeFeature(evt.feature)
  }, 0)

});


const changeControlType = (newControlType) => {
  controlType = newControlType
  switch (controlType) {
    case 'select-ptcl-lane-sections':
      modifyFmsLaneType = 'centerLine'
      map.removeInteraction(addLaneSectionsDraw)
      map.removeInteraction(addNodesAndLanesDraw)
      map.removeInteraction(addRoute)
      map.addInteraction(select)

      break;
    case 'add-nodes':
      map.removeInteraction(addLaneSectionsDraw)
      map.removeInteraction(addNodesAndLanesDraw)
      map.removeInteraction(addRoute)
      map.addInteraction(addNodes)
      map.addInteraction(snap);
      map.addInteraction(ptclSnap)
      map.addInteraction(centerLineSnap)

      modifyDelete = false
      break;
    case 'add-nodes-and-lanes':
      map.removeInteraction(addLaneSectionsDraw)
      map.removeInteraction(addNodes)
      map.removeInteraction(centerLineSnap)
      map.removeInteraction(addRoute)

      map.addInteraction(addNodesAndLanesDraw)
      map.addInteraction(nodeConnectorsSnap)
      map.addInteraction(centerLineSnap)

      modifyDelete = false
      break
    case 'modify-nodes':
      modifyFmsLaneType = 'fmsNode'
      map.removeInteraction(select)
      map.removeInteraction(addLaneSectionsDraw)
      map.removeInteraction(addNodesAndLanesDraw)
      map.removeInteraction(addNodes)
      map.removeInteraction(addRoute)

      map.addInteraction(select)
      map.addInteraction(addNodesSnap)

      modifyDelete = false
      break;
    case 'move-nodes':
      modifyFmsLaneType = 'fmsNode'
      map.removeInteraction(addLaneSectionsDraw)
      map.removeInteraction(addNodesAndLanesDraw)
      map.removeInteraction(addNodes)
      map.removeInteraction(centerLineSnap)
      map.removeInteraction(addRoute)

      map.addInteraction(select)
      map.addInteraction(centerLineSnap)
      modifyDelete = false

      break
    case 'add-lane-sections':
      map.removeInteraction(addNodes)
      map.removeInteraction(modifyFmsNodes)
      map.removeInteraction(addNodesAndLanesDraw)
      map.removeInteraction(addRoute)

      map.addInteraction(addLaneSectionsDraw)
      map.addInteraction(nodeConnectorsSnap)

      modifyDelete = false
      break;
    case 'modify-lane-sections':
      modifyFmsLaneType = 'modify-lane-sections'
      map.removeInteraction(addNodes)
      map.removeInteraction(addNodesAndLanesDraw)
      map.removeInteraction(addLaneSectionsDraw)
      map.removeInteraction(addRoute)

      map.addInteraction(centerLineSnap)
      modifyDelete = false
      break;
    case 'get-route':
      map.removeInteraction(addNodes)
      map.removeInteraction(addNodesAndLanesDraw)
      map.removeInteraction(addLaneSectionsDraw)
      map.removeInteraction(select)

      map.addInteraction(addRoute)
      modifyDelete = false;
  }
}

/**
 * Currently user has to manually select whether to draw or modify/delete
 * @type {HTMLElement}
 */
const typeSelect = document.getElementById('type');
console.log('typeSelect', typeSelect)
changeControlType(typeSelect.value)

typeSelect.onchange = () => {
  changeControlType(typeSelect.value)
}


// workaround for addNodesAndLanesDrawEndHandler evt.pixel not updated on drawend event and freehand is true
let pointerPixelCoord = null
map.on('pointermove', (evt) => {
  pointerPixelCoord = evt.pixel
})
map.on('wheel', (evt) => {
  const delta = evt.originalEvent.deltaY

  if(controlType === 'modify-nodes') {

    const increaseLaneWidth = evt.originalEvent.ctrlKey

    const snappedFmsNodeFeatures = map.getFeaturesAtPixel(evt.pixel).filter(feat => feat.get('fmsLaneType') === 'fmsNode');
    if (snappedFmsNodeFeatures.length === 0) {
      console.error('no fmsNode found at drawstart')
      return
    }
    const fmsNode = snappedFmsNodeFeatures[0].get('fmsNode')

    if (increaseLaneWidth) {
      const deltaStepMeter = 0.5
      const deltaWidth = delta / 120 * deltaStepMeter
      fmsNode.leftEdge.distanceFromReferencePoint += deltaWidth
      fmsNode.rightEdge.distanceFromReferencePoint += deltaWidth

    } else {
      const deltaRadians = delta / 120 * Math.PI / 180
      fmsNode.referenceHeading = fmsNode.referenceHeading + deltaRadians
    }
    redrawFmsNodes(fmsNode.id)
    evt.stopPropagation()
    evt.preventDefault()
  }
})

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

// onclick show-aerial
const showAerial = document.getElementById('show-aerial');
showAerial.onclick = () => {
  bing.setVisible(showAerial.checked)
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

function saveFile(blob, filename) {
  const a = document.createElement('a');
  document.body.appendChild(a);
  const url = window.URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => {
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 0)
}

// onclick export-embomap-json
const exportEmbomapJsonButton = document.getElementById('export-embomap-json');
exportEmbomapJsonButton.onclick = () => {
  const embomapJson = exportEmbomapJson()
  const embomapJsonString = JSON.stringify(embomapJson, null, 2)
  const blob = new Blob([embomapJsonString], {type: "application/json;charset=utf-8"});
  saveFile(blob, "embomap.json");
}

// onclick save-fms-map
const saveFmsMapButton = document.getElementById('save-fms-map');
saveFmsMapButton.onclick = () => {
   localStorage.setItem('fmsMap', JSON.stringify(fmsMap, null, 2))
   // localStorage.setItem('fmsMap', JSON.stringify(exportEmbomapJson(), null, 2))
}
const mineModelServiceHostUrl = 'http://localhost:5100'
const laneEmbomapUrl = mineModelServiceHostUrl + '/laneEmbomap'

// onclick sync-fms-map
const syncFmsMapButton = document.getElementById('sync-fms-map');
syncFmsMapButton.onclick = () => {
  const fmsMapString = localStorage.getItem('fmsMap')

  if (!fmsMapString) {
    console.error("No fmsMap in localStorage")
    return;
  }

  const fmsMap = exportEmbomapJson()
  const payload = {
    laneNodes: fmsMap.fmsNodes,
    laneSections: fmsMap.fmsLaneSections
  }
  fetch(laneEmbomapUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }).then(res => {
    console.log('Synced fmsMap to mine-model-service')
  }).catch(err => {
    console.error(err)
  })
}


// onclick show-section-boundaries
const showSectionBoundariesButton = document.getElementById('show-section-boundaries');
showSectionBoundariesButton.onclick = () => {
  ribsLayer.setVisible(showSectionBoundariesButton.checked)
}

// onclick fit-bezier
const fitBezierButton = document.getElementById('fit-bezier');
fitBezierButton.onclick = () => {
  const points = fmsNodes.map(fmsNode => [fmsNode.referencePoint.x, fmsNode.referencePoint.y])
  const error = 10
  const bezierCurves = fitCurve(points, error);
  console.log('bezierCurves', bezierCurves)

  const fitted = new MultiLineString([[]])
  bezierCurves.forEach(bezierCurve => {
      const centerLineBezier = new Bezier(
        bezierCurve[0][0], bezierCurve[0][1],
        bezierCurve[1][0], bezierCurve[1][1],
        bezierCurve[2][0], bezierCurve[2][1],
        bezierCurve[3][0], bezierCurve[3][1],
      );
      const centerLineBezierPoints = centerLineBezier.getLUT(bezierSteps)
      const centerLineBezierCoords = centerLineBezierPoints.map(centerLineBezierPoint => [centerLineBezierPoint.x, centerLineBezierPoint.y])
      fitted.appendLineString(new LineString(centerLineBezierCoords))
    })
  testSource.addFeature(new Feature(fitted))
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

// not quite embomap json format, but using similar concept with Nodes and laneSections
const exportEmbomapJson = () => {
  const mapViewProjCode = map.getView().getProjection().getCode()

  const fmsNodesTransformed = fmsNodes.map(fmsNode => {
    const transformedPoint = new Point([fmsNode.referencePoint.x, fmsNode.referencePoint.y]).transform(
      mapViewProjCode,
      FmsProjection).getCoordinates()

    const fmsNodeCloned = JSON.parse(JSON.stringify(fmsNode))
    fmsNodeCloned.referencePoint.x = transformedPoint[0]
    fmsNodeCloned.referencePoint.y = transformedPoint[1]
    return fmsNodeCloned
  })

  const fmsSectionBoundariesTransformed = fmsLaneSections.map(fmsLaneSection => {
    const fmsLaneSectionCloned = JSON.parse(JSON.stringify(fmsLaneSection))
    fmsLaneSectionCloned.sectionBoundaries.forEach(sectionBoundary => {
      const transformedPoint = new Point([sectionBoundary.referencePoint.x, sectionBoundary.referencePoint.y]).transform(
        mapViewProjCode,
        FmsProjection).getCoordinates()
      sectionBoundary.referencePoint.x = transformedPoint[0]
      sectionBoundary.referencePoint.y = transformedPoint[1]
    })
    return fmsLaneSectionCloned
  })

  return {
    units: {
      length: 'meters',
      angle: 'radians',
      projection: FmsProjection,
    },
    fmsNodes: fmsNodesTransformed,
    fmsLaneSections: fmsSectionBoundariesTransformed
  }
}
