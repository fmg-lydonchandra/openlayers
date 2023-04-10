/* eslint-disable */

import JSONFeature from './JSONFeature.js';
import {get as getProjection} from '../proj.js';
import Feature from '../Feature.js';
import {GeometryCollection, LineString, MultiLineString} from '../geom.js';
import Mgrs from '../../../public/mgrs.js';
import Polygon from '../geom/Polygon.js';

class PtclJSON extends JSONFeature {
  constructor(options) {
    super();
    options = options ? options : {};
    this.layerName_ = options.layerName;
    this.layers_ = options.layers ? options.layers : null;
    this.dataProjection = getProjection(
      options.dataProjection ? options.dataProjection : 'EPSG:4326'
    );
    this.mgrsSquare = options.mgrsSquare;
    if (!this.mgrsSquare) {
      throw new Error("mgrsSquare is not set");
    }
  }

  static BoundaryIx = 0;
  static RibsIx = 1;
  static CenterLineIx = 2;

  readFeatureFromObject(object, options) {
    return undefined;
  }

  readFeaturesFromObject(object, options) {
    options = options ? options : {};
    let features = [];

    if (!object.AreaMapDePtr.pathSections) {
      return features;
    }

    // const mgrsSquare = {
    //   utm_zone: 50,
    //   lat_band: 'J',
    //   column: 'M',
    //   row: 'K',
    // }
    for (let i = 0, ii = object.AreaMapDePtr.pathSections.length; i < ii; i++) {
      const pathSec = object.AreaMapDePtr.pathSections[i];
      const feature = new Feature();
      const geometry = new GeometryCollection([
        new Polygon([]), // boundary
        new MultiLineString([[]]),
        new LineString([])
      ]);
      let centreLines = [];
      let ribCoords = [];
      for (let j = 0; j < pathSec.numElements; j++) {
        const pathSecElem = pathSec.elements[j];
        const centerPointMgrs = [
          pathSecElem.referencePoint.x / 1000,
          pathSecElem.referencePoint.y / 1000,
        ];
        const mgrsInst = new Mgrs();
        const centerPoint = mgrsInst.mgrs_to_utm(centerPointMgrs, this.mgrsSquare);
        ribCoords.push(this.getCoordinates(pathSecElem, this.mgrsSquare))
        centreLines.push(centerPoint);
      }
      const geometries = geometry.getGeometries();

      let ribsGeom = PtclJSON.getRibsGeom(ribCoords);
      const ribsGeomTransformed = ribsGeom.transform('EPSG:28350', 'EPSG:3857');
      console.log('ribsGeom', ribsGeomTransformed)
      geometries[PtclJSON.RibsIx] = ribsGeomTransformed;

      let boundaryGeom = PtclJSON.getBoundaryGeom(ribCoords);
      const boundaryTransformed = boundaryGeom.transform('EPSG:28350', 'EPSG:3857');


      geometries[PtclJSON.BoundaryIx] = boundaryTransformed;
      let centreLineGeom = new LineString(centreLines);
      const centreLineTransformed = centreLineGeom.transform('EPSG:28350', 'EPSG:3857');
      geometries[PtclJSON.CenterLineIx] = centreLineTransformed;
      feature.setId("ptcl_" + pathSec.id);
      geometry.setGeometries(geometries)
      feature.setGeometry(geometry);
      console.log("feature", feature.getGeometry())

      features.push(feature);
    }
    // console.log(features)
    return features;
  }

  static getRibsGeom(ribsCoords) {
    const returnMultiLineString = new MultiLineString([[]])
    if (ribsCoords.length < 2) {
      return returnMultiLineString;
    }
    const LeftIx = 0;
    const CenterIx = 1;
    const RightIx = 2;
    const HalfLaneWidthMeter = 10;


    console.log('ribCoords', ribsCoords)
    for (let i = 1; i < ribsCoords.length; i++) {
      const curRib = ribsCoords[i]
      const prevRib = ribsCoords[i-1]

      const curRibCenter = curRib[CenterIx]
      const prevRibCenter = prevRib[CenterIx]

      //todo: include p5
      let prev = new p5.Vector(prevRibCenter[0], prevRibCenter[1]);
      let cur = new p5.Vector(curRibCenter[0], curRibCenter[1])
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
          prevRibCenter,
          [prevCoordLaneWidthVec.x, prevCoordLaneWidthVec.y],
        ]);
      leftRib.rotate(Math.PI / 2.0, prevRibCenter);

      let rightRib = new LineString(
        [
          prevRibCenter,
          [prevCoordLaneWidthVec.x, prevCoordLaneWidthVec.y],
        ]);
      rightRib.rotate(-Math.PI / 2.0, prevRibCenter);

      let ribLineString = new LineString(
        [
          leftRib.getCoordinates()[1],
          prevRibCenter,
          rightRib.getCoordinates()[1]
        ]
      )
      returnMultiLineString.appendLineString(ribLineString);
    }
    return returnMultiLineString;
  }

  static getBoundaryGeom(ribCoords) {
    // console.log('ribCoords', ribCoords)
    const boundaryCoords = [];
    if(ribCoords < 2) {
      throw new Error('pathSectionElements < 2');
    }
    const firstRib = ribCoords[0];
    boundaryCoords.push(firstRib[2]);
    boundaryCoords.push(firstRib[1]);
    boundaryCoords.push(firstRib[0]);

    // add left boundary
    for (let i = 1; i < ribCoords.length - 1; i++)
    {
      let rib = ribCoords[i];
      boundaryCoords.push(rib[0]);
    }

    let lastRib = ribCoords[ribCoords.length-1];
    boundaryCoords.push(lastRib[0]);
    boundaryCoords.push(lastRib[1]);
    boundaryCoords.push(lastRib[2]);

    // add right boundary
    for (let i = ribCoords.length - 2; i >= 0; i--)
    {
      let rib = ribCoords[i];
      boundaryCoords.push(rib[2]);
    }
    return new Polygon([ boundaryCoords ]);
  }

  getCoordinates(rib, mgrsSquare)
  {
    const mgrsInst = new Mgrs();

    // TO DO: implement using NetTopologySuite
    const angle = (rib.referenceHeading / 10000) + (Math.PI / 2);
    // 90 degrees to direction
    const left = [
      rib.referencePoint.x / 1000 + (rib.leftEdge.distanceFromReferencePoint / 1000 * Math.cos(angle)),
      rib.referencePoint.y / 1000 + (rib.leftEdge.distanceFromReferencePoint / 1000 * Math.sin(angle))
    ];
    const center = [
      rib.referencePoint.x / 1000,
      rib.referencePoint.y / 1000
    ];
    const right = [
      rib.referencePoint.x / 1000 - rib.rightEdge.distanceFromReferencePoint / 1000 * Math.cos(angle),
      rib.referencePoint.y / 1000 - rib.rightEdge.distanceFromReferencePoint / 1000 * Math.sin(angle)
    ];

    return [
      mgrsInst.mgrs_to_utm(left, mgrsSquare),
      mgrsInst.mgrs_to_utm(center, mgrsSquare),
      mgrsInst.mgrs_to_utm(right, mgrsSquare)
    ];
  }

  readGeometryFromObject(object, options) {
    return undefined;
  }

  readProjectionFromObject(object) {
    return undefined;
  }

  writeFeatureObject(feature, options) {
    return undefined;
  }

  writeFeaturesObject(features, options) {
    return undefined;
  }

  writeGeometryObject(geometry, options) {
    return undefined;
  }
}
export default PtclJSON;
