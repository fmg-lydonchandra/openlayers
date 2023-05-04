/* eslint-disable */

import Map from '../src/ol/Map.js';
import PtclJSON from '../src/ol/format/PtclJSON.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import proj4 from 'proj4';
import {Circle as CircleStyle, Circle, Fill, RegularShape, Stroke, Style} from '../src/ol/style.js';
import {Tile as TileLayer, Vector as VectorLayer} from '../src/ol/layer.js';
import {register} from '../src/ol/proj/proj4.js';
import {defaults as defaultControls} from '../src/ol/control/defaults.js';
import BingMaps from '../src/ol/source/BingMaps.js';
import {Draw, Modify, Select, Snap} from '../src/ol/interaction.js';
import {v4 as uuidv4} from 'uuid';
import {Bezier} from 'bezier-js';

import {GeometryCollection, LineString, MultiPoint, Point, Polygon} from '../src/ol/geom.js';
import {getCenter} from '../src/ol/extent.js';
import {toDegrees, toRadians} from '../src/ol/math.js';
import Feature from '../src/ol/Feature.js';
import {Collection, Overlay} from '../src/ol/index.js';
import {kinks, polygon} from '@turf/turf';

//todo: fix draw lane section with defective end rib and boundary when going from right to left
//todo: fix move node defect, which leave left-right points
//todo: serialize out into proper file for ingestion into FMS
//todo: restrict control points when angle is too extreme
//todo: split pathSection into multiple pathSections if it is too long
//todo: trace on survey data, left hand side ?
const MaxLaneLengthMeters = 50;
const MaxLanePoints = 100;
let halfLaneWidthMeter = 8.5;
let modifyFmsLaneType = 'fmsNodes'
let controlType = 'add-nodes'
let modifyDelete = false
const xUnitVec = new p5.Vector(1, 0)

let bezierSteps = 4;
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

//todo: is this used?
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

const nodeConnectorsSource = new VectorSource();
const nodeConnectorsLayer = new VectorLayer({
  source: nodeConnectorsSource,
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

// const ptclSource = new VectorSource({
//   url: 'flying_fish_original_ptcl_1.ptcl.json',
//   format: new PtclJSON({
//     dataProjection: 'EPSG:28350',
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
  layers: [ bing, vectorPtcl, newVector, addNodesLayer, addLaneSectionLayer, ribsLayer, centerLineLayer, boundaryLayer, nodeConnectorsLayer],
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

const setFmsLaneSectionWeights = () => {
  const fmsLaneSectionId = document.getElementById('fms-lane-section-id').value;
  const startWeight = document.getElementById('fms-lane-section-start-weight').value;
  const endWeight = document.getElementById('fms-lane-section-end-weight').value;
  const bezierSteps = document.getElementById('fms-lane-section-bezier-steps').value;
  const fmsLaneSection = fmsLaneSections.find(fmsLaneSection => fmsLaneSection.id === fmsLaneSectionId);
  fmsLaneSection.startWeight = parseFloat(startWeight);
  fmsLaneSection.endWeight = parseFloat(endWeight);
  fmsLaneSection.bezierSteps = parseInt(bezierSteps);
  redrawFmsLaneSections(fmsLaneSectionId)
}
window.updateFmsLaneSection = setFmsLaneSectionWeights.bind(this);

const deleteFmsLaneSection = () => {
  if(window.confirm("Delete lane section?")) {
    const fmsLaneSectionId = document.getElementById('fms-lane-section-id').value;
    const fmsLaneSectionIx = fmsLaneSections.findIndex(fmsLaneSection => fmsLaneSection.id === fmsLaneSectionId);

    fmsLaneSections.splice(fmsLaneSectionIx, 1);

    const centerLineFeature = centerLineSource.getFeatures().find(feat => feat.get('fmsPathSectionId') === fmsLaneSectionId)
    centerLineSource.removeFeature(centerLineFeature);

    const ribsFeature = ribsSource.getFeatures().find(feat => feat.get('fmsPathSectionId') === fmsLaneSectionId)
    ribsSource.removeFeature(ribsFeature);

    const boundaryFeature = boundarySource.getFeatures().find(feat => feat.get('fmsPathSectionId') === fmsLaneSectionId)
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
        <input id='fms-node-heading' type='text' value='${fmsNode.referenceHeading}'></p>
      <p>Width:
        <input type='text' id='fms-node-width'
          value='${fmsNode.leftEdge.distanceFromReferencePoint + fmsNode.rightEdge.distanceFromReferencePoint}'
      </p>
      <p>Prev Sections: ${fmsNode.prevSectionsId.join(",")} </p>
      <button onclick="window.updateFmsNode()">Set</button>
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
      <p>Bezier Steps: <input id='fms-lane-section-bezier-steps' type='text' value='${fmsLaneSection.bezierSteps}'></p>

      <button onclick='window.updateFmsLaneSection()'>Set</button>
      <button onclick='window.deleteFmsLaneSection()'>Delete</button>
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

  let center = new p5.Vector(fmsNode.referencePoint.x, fmsNode.referencePoint.y)
  let directionNorm = p5.Vector.rotate(xUnitVec, fmsNode.referenceHeading)
  const selectorDistance = 5
  const sameHeadingPoint = p5.Vector.add(center, p5.Vector.mult(directionNorm, selectorDistance))
  const sameHeadingGeom = new Point([sameHeadingPoint.x, sameHeadingPoint.y])

  const connectorHeadingSame = nodeConnectorsSource.getFeatures().find(feat => feat.get('fmsNodeId') === fmsNodeId && feat.get('fmsNodeConnectorHeading') === 'same')
  connectorHeadingSame.setGeometry(sameHeadingGeom)

  const oppositeHeadingPoint = p5.Vector.sub(center, p5.Vector.mult(directionNorm, selectorDistance))
  const oppositePointGeom = new Point([oppositeHeadingPoint.x, oppositeHeadingPoint.y])
  const connectorHeadingOpposite = nodeConnectorsSource.getFeatures().find(feat => feat.get('fmsNodeId') === fmsNodeId && feat.get('fmsNodeConnectorHeading') === 'opposite')
  connectorHeadingOpposite.setGeometry(oppositePointGeom)

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

const createBezierLineGeom = (fmsLaneSection, linePosition) => {
  const startFmsNode = fmsLaneSection.startFmsNode
  const startFmsNodeConnectorHeading = fmsLaneSection.startFmsNodeConnectorHeading
  const endFmsNode = fmsLaneSection.endFmsNode
  const endFmsNodeConnectorHeading = fmsLaneSection.endFmsNodeConnectorHeading

  const starFmsNodeCenterPt = new p5.Vector(startFmsNode.referencePoint.x, startFmsNode.referencePoint.y)
  const startFmsNodeDirectionNorm = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
  let starFmsNodeDirectionLaneWidth = p5.Vector.mult(startFmsNodeDirectionNorm, startFmsNode.leftEdge.distanceFromReferencePoint)

  let startFmsNodeLeftLaneWidthVec;

  switch (linePosition) {
    case 'left':
      startFmsNodeLeftLaneWidthVec = p5.Vector.add(starFmsNodeCenterPt, starFmsNodeDirectionLaneWidth);
      break;
    case 'right':
      startFmsNodeLeftLaneWidthVec = p5.Vector.sub(starFmsNodeCenterPt, starFmsNodeDirectionLaneWidth);
      break;
    default:
      throw new Error('linePosition must be left or right')
  }

  let startFmsNodeLeftRib = new LineString(
    [
      [starFmsNodeCenterPt.x, starFmsNodeCenterPt.y],
      [startFmsNodeLeftLaneWidthVec.x, startFmsNodeLeftLaneWidthVec.y],
    ]);
  startFmsNodeLeftRib.rotate(Math.PI / 2.0, [starFmsNodeCenterPt.x, starFmsNodeCenterPt.y]);
  // centerLineSource.addFeature(new Feature(startFmsNodeLeftRib))
  let leftBezierPt1 = new p5.Vector(startFmsNodeLeftRib.getCoordinates()[1][0], startFmsNodeLeftRib.getCoordinates()[1][1])
  let leftBezierPt2;
  if (startFmsNodeConnectorHeading === 'same') {
    const pt2direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
    const pt2startWeight = p5.Vector.mult(pt2direction, fmsLaneSection.startWeight)
    leftBezierPt2 = p5.Vector.add(leftBezierPt1, pt2startWeight)
  } else if (startFmsNodeConnectorHeading === 'opposite') {
    const pt2direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading + Math.PI)
    const pt2startWeight = p5.Vector.mult(pt2direction, fmsLaneSection.startWeight)
    leftBezierPt2 = p5.Vector.add(leftBezierPt1, pt2startWeight)
  }
  else {
    throw new Error('startFmsNodeConnectorHeading must be same or opposite')
  }

  const endFmsNodeCenterPt = new p5.Vector(endFmsNode.referencePoint.x, endFmsNode.referencePoint.y)
  const endFmsNodeDirectionNorm = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
  let endFmsNodeDirectionLaneWidth = p5.Vector.mult(endFmsNodeDirectionNorm, endFmsNode.leftEdge.distanceFromReferencePoint)

  let endFmsNodeLaneWidthVec;

  switch (linePosition) {
    case 'left':
      endFmsNodeLaneWidthVec = p5.Vector.add(endFmsNodeCenterPt, endFmsNodeDirectionLaneWidth);
      break;
    case 'right':
      endFmsNodeLaneWidthVec = p5.Vector.sub(endFmsNodeCenterPt, endFmsNodeDirectionLaneWidth);
      break;
    default:
      throw new Error('linePosition must be left or right')
  }

  let endFmsNodeLeftRib = new LineString(
    [
      [endFmsNodeCenterPt.x, endFmsNodeCenterPt.y],
      [endFmsNodeLaneWidthVec.x, endFmsNodeLaneWidthVec.y],
    ]);
  endFmsNodeLeftRib.rotate(Math.PI / 2.0, [endFmsNodeCenterPt.x, endFmsNodeCenterPt.y]);
  const leftBezierPt4 = new p5.Vector(endFmsNodeLeftRib.getCoordinates()[1][0], endFmsNodeLeftRib.getCoordinates()[1][1])

  let leftBezierPt3;
  if (endFmsNodeConnectorHeading === 'same') {
    const pt3direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading + Math.PI)
    const pt3endWeight = p5.Vector.mult(pt3direction, fmsLaneSection.endWeight)
    leftBezierPt3 = p5.Vector.sub(leftBezierPt4, pt3endWeight)
  }
  else if (endFmsNodeConnectorHeading === 'opposite') {
    const pt3direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
    const pt3endWeight = p5.Vector.mult(pt3direction, fmsLaneSection.endWeight)
    leftBezierPt3 = p5.Vector.sub(leftBezierPt4, pt3endWeight)
  }
  else {
    throw new Error('endFmsNodeConnectorHeading must be same or opposite')
  }

  const leftBezier = new Bezier(
    leftBezierPt1.x, leftBezierPt1.y,
    leftBezierPt2.x, leftBezierPt2.y,
    leftBezierPt3.x, leftBezierPt3.y,
    leftBezierPt4.x, leftBezierPt4.y);
  const leftLuts = leftBezier.getLUT(fmsLaneSection.bezierSteps).map(lut => [lut.x, lut.y])
  return new LineString(leftLuts);
}

const createBezierCenterLineGeom = (fmsLaneSection) => {
  const startFmsNode = fmsLaneSection.startFmsNode
  const startFmsNodeConnectorHeading = fmsLaneSection.startFmsNodeConnectorHeading
  const endFmsNode = fmsLaneSection.endFmsNode
  const endFmsNodeConnectorHeading = fmsLaneSection.endFmsNodeConnectorHeading
  const bezierPt1 = startFmsNode.referencePoint
  const pt2 = new p5.Vector(startFmsNode.referencePoint.x, startFmsNode.referencePoint.y)
  let bezierPt2;
  if (startFmsNodeConnectorHeading === 'same') {
    const pt2direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
    const pt2startWeight = p5.Vector.mult(pt2direction, fmsLaneSection.startWeight)
    bezierPt2 = p5.Vector.add(pt2, pt2startWeight)
  } else if (startFmsNodeConnectorHeading === 'opposite') {
    const pt2direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading + Math.PI)
    const pt2startWeight = p5.Vector.mult(pt2direction, fmsLaneSection.startWeight)
    bezierPt2 = p5.Vector.add(pt2, pt2startWeight)
  }
  else {
    throw new Error('startFmsNodeConnectorHeading must be same or opposite')
  }

  const pt3 = new p5.Vector(endFmsNode.referencePoint.x, endFmsNode.referencePoint.y)
  let bezierPt3;
  if (endFmsNodeConnectorHeading === 'same') {
    const pt3direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading + Math.PI)
    const pt3endWeight = p5.Vector.mult(pt3direction, fmsLaneSection.endWeight)
    bezierPt3 = p5.Vector.sub(pt3, pt3endWeight)
  }
  else if (endFmsNodeConnectorHeading === 'opposite') {
    const pt3direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
    const pt3endWeight = p5.Vector.mult(pt3direction, fmsLaneSection.endWeight)
    bezierPt3 = p5.Vector.sub(pt3, pt3endWeight)
  }
  else {
    throw new Error('endFmsNodeConnectorHeading must be same or opposite')
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

const calculateRibsAndBoundaryGeom = (fmsLaneSection, centerLineCoords) => {
  const startFmsNode = fmsLaneSection.startFmsNode
  const startFmsNodeConnectorHeading = fmsLaneSection.startFmsNodeConnectorHeading
  const endFmsNode = fmsLaneSection.endFmsNode
  const endFmsNodeConnectorHeading = fmsLaneSection.endFmsNodeConnectorHeading
  const pathSection = {
    elements: []
  }

  const leftBoundaryLine = createBezierLineGeom(fmsLaneSection, 'left')

  const rightBoundaryLine = createBezierLineGeom(fmsLaneSection, 'right')

  for (let i = 1; i < centerLineCoords.length; i++) {
    const curCoord = centerLineCoords[i]
    const prevCoord = centerLineCoords[i-1]
    let prev = new p5.Vector(prevCoord[0], prevCoord[1]);
    let cur = new p5.Vector(curCoord[0], curCoord[1])
    let direction = p5.Vector.sub(cur, prev)

    //todo: refactor drawRibsRotation style to use this
    if (i === 1) {
      if (startFmsNodeConnectorHeading === 'same') {
        direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading)
      }
      else {
        direction = p5.Vector.rotate(xUnitVec, startFmsNode.referenceHeading + Math.PI)
      }
    }
    else if(i === centerLineCoords.length - 1) {
      if (endFmsNodeConnectorHeading === 'same') {
        direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading + Math.PI)
      }
      else {
        direction = p5.Vector.rotate(xUnitVec, endFmsNode.referenceHeading)
      }
    }

    let rotationFromEast = direction.heading()

    let pathSectionElement = {
      id: uuidv4(),
      referencePoint: { x: prevCoord[0], y: prevCoord[1] },
      // referenceHeading: rotation,
      referenceHeading: rotationFromEast,
      leftEdge: {
        distanceFromReferencePoint: halfLaneWidthMeter,
      },
      rightEdge: {
        distanceFromReferencePoint: halfLaneWidthMeter,
      }
    }
    pathSection.elements.push(pathSectionElement);

    if (i === centerLineCoords.length - 1) {
      pathSectionElement = {
        id: uuidv4(),
        referencePoint: { x: curCoord[0], y: curCoord[1] },
        referenceHeading: rotationFromEast,
        leftEdge: {
          distanceFromReferencePoint: halfLaneWidthMeter,
        },
        rightEdge: {
          distanceFromReferencePoint: halfLaneWidthMeter,
        }
      }
      pathSection.elements.push(pathSectionElement);
    }
  }

  const ribsCoords = []
  for (let i = 0; i < pathSection.elements.length; i++) {
    const pathSectionElem = pathSection.elements[i]
    const ribCoords = PtclJSON.calcRibsCoordsInMapProjection(pathSectionElem)
    ribsCoords.push(ribCoords)
  }
  const ribsGeom = PtclJSON.ribsToMultiLineString(ribsCoords)
  // const boundaryGeom = PtclJSON.getBoundaryGeom(ribsCoords)
  const ribsCoordsBezier = [];
  ribsCoordsBezier.push(ribsCoords[0][2])
  ribsCoordsBezier.push(ribsCoords[0][1])
  ribsCoordsBezier.push(ribsCoords[0][0])
  ribsCoordsBezier.push(...leftBoundaryLine.getCoordinates())
  ribsCoordsBezier.push(ribsCoords[ribsCoords.length-1][0])
  ribsCoordsBezier.push(ribsCoords[ribsCoords.length-1][1])
  ribsCoordsBezier.push(ribsCoords[ribsCoords.length-1][2])
  ribsCoordsBezier.push(...(rightBoundaryLine.getCoordinates().reverse()))
  ribsCoordsBezier.push(ribsCoords[0][2])

  const boundaryGeom = new Polygon ([ribsCoordsBezier]);

  return { ribsGeom, boundaryGeom }
}

const redrawFmsLaneSections = (fmsLaneSectionId, bezierSteps) => {
  const fmsLaneSection = fmsLaneSections.find(fmsLaneSection => fmsLaneSection.id === fmsLaneSectionId)

  const centerLine = createBezierCenterLineGeom(fmsLaneSection)
  centerLineSource.getFeatures().find(feat => feat.get('fmsPathSectionId') === fmsLaneSectionId).setGeometry(centerLine)

  const centerLineCoords = centerLine.getCoordinates();

  const ribsBoundaryGeomObj = calculateRibsAndBoundaryGeom(fmsLaneSection, centerLineCoords);
  const ribsGeom = ribsBoundaryGeomObj.ribsGeom
  const boundaryGeom = ribsBoundaryGeomObj.boundaryGeom
  ribsSource.getFeatures().find(feat => feat.get('fmsPathSectionId') === fmsLaneSectionId).setGeometry(ribsGeom)
  boundarySource.getFeatures().find(feat => feat.get('fmsPathSectionId') === fmsLaneSectionId).setGeometry(boundaryGeom)
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

  let center = new p5.Vector(fmsNode.referencePoint.x, fmsNode.referencePoint.y)
  let directionNorm = p5.Vector.rotate(xUnitVec, fmsNode.referenceHeading)

  const selectorDistance = 5
  const sameHeadingPoint = p5.Vector.add(center, p5.Vector.mult(directionNorm, selectorDistance))
  const sameHeadingGeom = new Point([sameHeadingPoint.x, sameHeadingPoint.y])
  const sameHeadingFeature = new Feature(sameHeadingGeom)
  sameHeadingFeature.set('fmsNode', fmsNode)
  sameHeadingFeature.set('fmsNodeId', fmsNode.id)
  sameHeadingFeature.set('fmsLaneType', 'connector')
  sameHeadingFeature.set('fmsNodeConnectorHeading', 'same')
  nodeConnectorsSource.addFeature(sameHeadingFeature)

  const oppositeHeadingPoint = p5.Vector.sub(center, p5.Vector.mult(directionNorm, selectorDistance))
  const oppositePointGeom = new Point([oppositeHeadingPoint.x, oppositeHeadingPoint.y])
  const oppositePointFeature = new Feature(oppositePointGeom)
  oppositePointFeature.set('fmsNode', fmsNode)
  oppositePointFeature.set('fmsNodeId', fmsNode.id)
  oppositePointFeature.set('fmsLaneType', 'connector')
  oppositePointFeature.set('fmsNodeConnectorHeading', 'opposite')
  nodeConnectorsSource.addFeature(oppositePointFeature)
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
  const snappedFmsNodeFeatures = map.getFeaturesAtPixel(evt.target.downPx_).filter(feat => feat.get('fmsLaneType') === 'connector');
  if (snappedFmsNodeFeatures.length === 0) {
    throw Error('no fmsNode found at drawstart')
  }
  console.log(snappedFmsNodeFeatures)
  const fmsNode = snappedFmsNodeFeatures[0].get('fmsNode')
  const fmsNodeConnectorHeading = snappedFmsNodeFeatures[0].get('fmsNodeConnectorHeading')
  evt.feature.set('startFmsNode', fmsNode)
  evt.feature.set('fmsNodeConnectorHeading', fmsNodeConnectorHeading)
});

addLaneSectionsDraw.on('drawend', (evt) => {
  const fmsPathSectionId = evt.feature.get('fmsPathSectionId')

  const endFmsNodeFeatures = map.getFeaturesAtPixel(evt.target.downPx_).filter(feat => feat.get('fmsLaneType') === 'connector');
  if (endFmsNodeFeatures.length === 0) {
    throw Error('no fmsNode found at drawend')
  }
  const endFmsNode = endFmsNodeFeatures[0].get('fmsNode')
  const endFmsNodeConnectorHeading = endFmsNodeFeatures[0].get('fmsNodeConnectorHeading')
  endFmsNode.prevSectionsId.push(fmsPathSectionId)

  const startFmsNode = evt.feature.get('startFmsNode')
  const startFmsNodeConnectorHeading = evt.feature.get('fmsNodeConnectorHeading')
  startFmsNode.nextSectionsId.push(fmsPathSectionId)

  const fmsLaneSection = {
    id: fmsPathSectionId,
    startFmsNode: startFmsNode,
    startFmsNodeConnectorHeading: startFmsNodeConnectorHeading,
    endFmsNode: endFmsNode,
    endFmsNodeConnectorHeading: endFmsNodeConnectorHeading,
    startWeight: PathSectionStartWeightMeter,
    endWeight: PathSectionEndWeightMeter,
    bezierSteps: bezierSteps
  }
  fmsLaneSections.push(fmsLaneSection)

  const centerLineGeom = createBezierCenterLineGeom(fmsLaneSection)

  const centerLineFeature = new Feature({
    geometry: centerLineGeom,
  })
  centerLineFeature.set('fmsLaneType', 'centerLine')
  centerLineFeature.set('fmsPathSectionId', fmsPathSectionId)
  centerLineFeature.set('fmsLaneSection', fmsLaneSection)
  centerLineSource.addFeature(centerLineFeature)

  const centerLineCoords = centerLineGeom.getCoordinates();

  const ribsBoundaryGeomObj = calculateRibsAndBoundaryGeom(fmsLaneSection, centerLineCoords);
  const ribsGeom = ribsBoundaryGeomObj.ribsGeom
  const ribsFeature = new Feature({
    geometry: ribsGeom
  })
  ribsFeature.set('fmsLaneType', 'ribs')
  ribsFeature.set('fmsPathSectionId', fmsPathSectionId)
  ribsFeature.set('fmsLaneSection', fmsLaneSection)
  ribsSource.addFeature(ribsFeature)

  const boundaryGeom = ribsBoundaryGeomObj.boundaryGeom
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
      map.removeInteraction(addLaneSectionsDraw)

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
      // map.addInteraction(addNodesSnap)
      break
    case 'add-lane-sections':
      map.removeInteraction(addNodes)
      map.removeInteraction(modifyFmsNodes)

      map.addInteraction(addLaneSectionsDraw)
      // map.addInteraction(addNodesSnap)
      map.addInteraction(nodeConnectorsSnap)

      modifyDelete = false
      break;
    case 'modify-lane-sections':
      modifyFmsLaneType = 'modify-lane-sections'
      // map.addInteraction(modifyNodes)
      map.removeInteraction(addNodes)
      map.removeInteraction(addLaneSectionsDraw)
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
