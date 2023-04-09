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
      // console.log('pathSec.numElements',pathSec.numElements)
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
      let boundaryGeom = PtclJSON.getBoundary(ribCoords);
      const boundaryTransformed = boundaryGeom.transform('EPSG:28350', 'EPSG:3857');

      const geometries = geometry.getGeometries();
      geometries[PtclJSON.BoundaryIx] = boundaryTransformed;
      let centreLineGeom = new LineString(centreLines);
      const centreLineTransformed = centreLineGeom.transform('EPSG:28350', 'EPSG:3857');
      geometries[PtclJSON.CenterLineIx] = centreLineTransformed;
      feature.setId("ptcl_" + pathSec.id);
      geometry.setGeometries(geometries)
      // feature.setGeometry(transformed);
      // feature.setGeometry(boundaryTransformed);
      feature.setGeometry(geometry);
      console.log("feature", feature.getGeometry())

      features.push(feature);
    }
    // console.log(features)
    return features;
  }

  static getBoundary(ribCoords) {
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
