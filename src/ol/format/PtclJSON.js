/* eslint-disable */

import JSONFeature from './JSONFeature.js';
import {get as getProjection} from '../proj.js';
import Feature from '../Feature.js';
import {GeometryCollection, LineString, MultiLineString, MultiPoint} from '../geom.js';
import Mgrs from '../../../public/mgrs.js';
import Polygon from '../geom/Polygon.js';
import { v4 as uuidv4 } from 'uuid';

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
    this.fmsPathSections_ = {}
  }

  static BoundaryIx = 0;
  static RibsIx = 1;
  static CenterLineIx = 2;
  static FirstLastPointsIx = 3;

  readFeatureFromObject(object, options) {
    return undefined;
  }

  getFmsPathSections() {
    return this.fmsPathSections_;
  }
  readFeaturesFromObject(object, options) {
    options = options ? options : {};
    let features = [];
    const pathSections = object.AreaMapDePtr.pathSections
    if (!pathSections) {
      return features;
    }

    // const mgrsSquare = {
    //   utm_zone: 50,
    //   lat_band: 'J',
    //   column: 'M',
    //   row: 'K',
    // }
    for (let i = 0, ii = pathSections.length; i < ii; i++) {
      const pathSection = pathSections[i];
      this.fmsPathSections_[pathSection.id] = pathSection;
      let centerLineCoords = [];
      let ribsCoords = [];
      let firstLastPoints = [];
      for (let j = 0; j < pathSection.numElements; j++) {
        const pathSecElem = pathSection.elements[j];
        const centerPointMgrs = [
          pathSecElem.referencePoint.x / 1000,
          pathSecElem.referencePoint.y / 1000,
        ];
        const mgrsInst = new Mgrs();
        const centerPoint = mgrsInst.mgrs_to_utm(centerPointMgrs, this.mgrsSquare);
        const ribCoords = this.calcRibsCoordsFromMgrs(pathSecElem, this.mgrsSquare)
        ribsCoords.push(ribCoords)
        centerLineCoords.push(centerPoint);
        if(j === 0 || j === pathSection.numElements - 1) {
          firstLastPoints.push(centerPoint);
        }

        const ribLineString = new LineString(ribCoords).transform('EPSG:28350', 'EPSG:3857')
        const ribFeature = new Feature(ribLineString);
        ribFeature.set('fmsLaneType', 'ribs')
        ribFeature.set('fmsPathSectionId', pathSection.id)
        ribFeature.set('fmsRibsId', j)
        this.layers_.ribs.getSource().addFeature(ribFeature);
      }

      const boundaryGeom = PtclJSON.getBoundaryGeom(ribsCoords).transform('EPSG:28350', 'EPSG:3857')
      const boundaryFeature = new Feature(boundaryGeom)
      boundaryFeature.set('fmsLaneType', 'boundary')
      boundaryFeature.set('fmsPathSectionId', pathSection.id)
      this.layers_.boundary.getSource().addFeature(boundaryFeature)

      let centerLineGeom = new LineString(centerLineCoords).transform('EPSG:28350', 'EPSG:3857');
      const centerLineFeature = new Feature(centerLineGeom)
      centerLineFeature.set('fmsLaneType', 'centerLine')
      centerLineFeature.set('fmsPathSectionId', pathSection.id)
      this.layers_.centerLine.getSource().addFeature(centerLineFeature)

      // let firstLastPointsGeom = new MultiPoint(firstLastPoints);
      // geometries[PtclJSON.FirstLastPointsIx] = firstLastPointsGeom.transform('EPSG:28350', 'EPSG:3857');
    }
    return features;
  }

  /**
   * Create a LineString from 3 points (left, center, right)
   * @param ribCoords
   * @returns {LineString}
   */
  static ribToLineString(ribCoords) {
    const LeftIx = 0;
    const CenterIx = 1;
    const RightIx = 2;

    return new LineString(
      [
        ribCoords[LeftIx],
        ribCoords[CenterIx],
        ribCoords[RightIx],
      ]
    )
  }

  /**
   * Create a MultiLineString from an array of ribs coordinates [(left, center, right)]
   * @param ribsCoords
   * @returns {MultiLineString}
   */
  static ribsToMultiLineString(ribsCoords) {
    const returnMultiLineString = new MultiLineString([[]])
    if (ribsCoords.length < 2) {
      return returnMultiLineString;
    }
    ribsCoords.forEach(ribCoords => returnMultiLineString.appendLineString(PtclJSON.ribToLineString(ribCoords)))

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

  /**
   * Use for PTCL json import, using MGRS transformation to UTM zone 50 / X
   * @param pathSectionElem
   * @param mgrsSquare
   * @returns {*[]}
   */
  calcRibsCoordsFromMgrs(pathSectionElem, mgrsSquare)
  {
    const mgrsInst = new Mgrs();

    // TO DO: implement using NetTopologySuite
    const angle = (pathSectionElem.referenceHeading / 10000) + (Math.PI / 2);
    // 90 degrees to direction
    const left = [
      pathSectionElem.referencePoint.x / 1000 + (pathSectionElem.leftEdge.distanceFromReferencePoint / 1000 * Math.cos(angle)),
      pathSectionElem.referencePoint.y / 1000 + (pathSectionElem.leftEdge.distanceFromReferencePoint / 1000 * Math.sin(angle))
    ];
    const center = [
      pathSectionElem.referencePoint.x / 1000,
      pathSectionElem.referencePoint.y / 1000
    ];
    const right = [
      pathSectionElem.referencePoint.x / 1000 - pathSectionElem.rightEdge.distanceFromReferencePoint / 1000 * Math.cos(angle),
      pathSectionElem.referencePoint.y / 1000 - pathSectionElem.rightEdge.distanceFromReferencePoint / 1000 * Math.sin(angle)
    ];

    return [
      mgrsInst.mgrs_to_utm(left, mgrsSquare),
      mgrsInst.mgrs_to_utm(center, mgrsSquare),
      mgrsInst.mgrs_to_utm(right, mgrsSquare)
    ];
  }

  static calcRibsCoordsInMapProjection(pathSectionElem) {
    const angle = (pathSectionElem.referenceHeading) + (Math.PI / 2);

    // 90 degrees to direction
    const left = [
      pathSectionElem.referencePoint.x + (pathSectionElem.leftEdge.distanceFromReferencePoint * Math.cos(angle)),
      pathSectionElem.referencePoint.y + (pathSectionElem.leftEdge.distanceFromReferencePoint * Math.sin(angle))
    ];
    const center = [
      pathSectionElem.referencePoint.x,
      pathSectionElem.referencePoint.y
    ];
    const right = [
      pathSectionElem.referencePoint.x - pathSectionElem.rightEdge.distanceFromReferencePoint * Math.cos(angle),
      pathSectionElem.referencePoint.y - pathSectionElem.rightEdge.distanceFromReferencePoint * Math.sin(angle)
    ];
    return [left, center, right]
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
