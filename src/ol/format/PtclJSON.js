/* eslint-disable */

import JSONFeature from './JSONFeature.js';
import {get as getProjection} from '../proj.js';
import Feature from '../Feature.js';
import {GeometryCollection, LineString, MultiLineString, MultiPoint} from '../geom.js';
import Mgrs from '../../../public/mgrs.js';
import Polygon from '../geom/Polygon.js';
import Point from '../geom/Point.js';
import { Vector } from 'p5';
import {v4 as uuidv4} from 'uuid';

class PtclJSON extends JSONFeature {
  constructor(options) {
    super();
    options = options ? options : {};
    this.layerName_ = options.layerName;
    this.layers_ = options.layers ? options.layers : null;
    this.dataProjection = getProjection(
      options.dataProjection ? options.dataProjection : 'EPSG:28350'
    );
    this.featureProjection = getProjection(
      options.featureProjection ? options.featureProjection : 'EPSG:3857'
    );
    this.mgrsSquare = options.mgrsSquare;
    if (!this.mgrsSquare) {
      throw new Error("mgrsSquare is not set");
    }
    //original ptclJson
    this.ptclJson_ = {}
    //transformed to map projection in meters and radians
    this.ptclJsonMapProjRad = {
      AreaMapDePtr: {
        pathSections: []
      }
    }
    this.fmsNodes = [];
  }

  static BoundaryIx = 0;
  static RibsIx = 1;
  static CenterLineIx = 2;
  static FirstLastPointsIx = 3;

  readFeatureFromObject(object, options) {
    return undefined;
  }

  getFmsPathSections() {
    return this.ptclJsonMapProjRad.AreaMapDePtr.pathSections;
  }

  getFmsNodes() {
    return this.fmsNodes;
  }

  readFeaturesFromObject(object, options) {
    this.ptclJson_ = object;
    options = options ? options : {};
    let features = [];
    const pathSections = this.ptclJson_.AreaMapDePtr.pathSections
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
      const pathSection = JSON.parse(JSON.stringify(pathSections[i]))
      this.ptclJsonMapProjRad.AreaMapDePtr.pathSections.push(pathSection);

      let centerLineCoords = [];
      let ribsCoords = [];
      for (let j = 0; j < pathSection.numElements; j++) {
        const pathSecElem = pathSection.elements[j];
        pathSecElem.id = j;
        const centerPointMgrs = [
          pathSecElem.referencePoint.x / 1000,
          pathSecElem.referencePoint.y / 1000,
        ];
        const mgrsInst = new Mgrs();
        const centerPoint = mgrsInst.mgrs_to_utm(centerPointMgrs, this.mgrsSquare);

        const centerPointMapProj = new Point(centerPoint).transform(this.dataProjection, this.featureProjection).getCoordinates()
        pathSecElem.referencePoint.x = centerPointMapProj[0];
        pathSecElem.referencePoint.y = centerPointMapProj[1];
        pathSecElem.leftEdge.distanceFromReferencePoint = pathSecElem.leftEdge.distanceFromReferencePoint / 1000;
        pathSecElem.rightEdge.distanceFromReferencePoint = pathSecElem.rightEdge.distanceFromReferencePoint / 1000;
        pathSecElem.referenceHeading = pathSecElem.referenceHeading / 10_000

        const ribCoords = PtclJSON.calcRibsCoordsInMapProjection(pathSecElem)
        ribsCoords.push(ribCoords)
        centerLineCoords.push(centerPointMapProj);
        // if(j === 0 || j === pathSection.numElements - 1) {
        //   const ribLineString = new LineString(ribCoords)
        //   const ribFeature = new Feature(ribLineString);
        //   ribFeature.set('fmsLaneType', 'ribs')
        //   ribFeature.set('fmsPathSectionId', pathSection.id)
        //   ribFeature.set('fmsRibsId', j)
        //   this.layers_.ribs.getSource().addFeature(ribFeature);
        // }

        if (j === 0 || j === pathSection.numElements - 1) {
          const fmsNode = {
            id: uuidv4(),
            referencePoint: {
              x: centerPointMapProj[0],
              y: centerPointMapProj[1],
            },
            referenceHeading: pathSecElem.referenceHeading,
            leftEdge: {
              distanceFromReferencePoint: pathSecElem.leftEdge.distanceFromReferencePoint,
            },
            rightEdge: {
              distanceFromReferencePoint: pathSecElem.rightEdge.distanceFromReferencePoint,
            },
            nextSectionsId: [],
            prevSectionsId: [],
          }
          this.fmsNodes.push(fmsNode);

          // const geometry = this.createNodesGeomCol(centerPointMapProj, {
          //   referenceHeading: fmsNode.referenceHeading,
          //   laneWidth: fmsNode.leftEdge.distanceFromReferencePoint
          // })

          // const fmsNodeFeature = new Feature(geometry);
          // fmsNodeFeature.set('fmsLaneType', 'fmsNodePtcl')
          // fmsNodeFeature.set('fmsLaneSectionIdPtcl', pathSection.id)
          // //todo: add fmsNodesConnector features
          // this.layers_.fmsNodes.getSource().addFeature(fmsNodeFeature);
        }
        //todo: ribs as multiLineString
        //todo: add nodes (at start and end)
      }

      const boundaryGeom = PtclJSON.getBoundaryGeom(ribsCoords)
      const boundaryFeature = new Feature(boundaryGeom)
      boundaryFeature.set('fmsLaneType', 'boundary')
      boundaryFeature.set('fmsPathSectionId', pathSection.id)
      this.layers_.boundary.getSource().addFeature(boundaryFeature)

      let centerLineGeom = new LineString(centerLineCoords)
      const centerLineFeature = new Feature(centerLineGeom)
      centerLineFeature.set('fmsLaneType', 'centerLine')
      centerLineFeature.set('fmsPathSectionId', pathSection.id)
      this.layers_.centerLine.getSource().addFeature(centerLineFeature)

    }
    return features;
  }

  createNodesGeomCol (coordinates, options) {
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

    let cur = new Vector(curCoord[0], curCoord[1])
    let directionNorm = new Vector(1, 0)
    directionNorm = Vector.rotate(directionNorm, options.referenceHeading)

    let directionLaneWidth = Vector.mult(directionNorm, options.laneWidth)

    let prevCoordLaneWidthVec = Vector.add(cur, directionLaneWidth);
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
    const angleRight = (pathSectionElem.referenceHeading) - (Math.PI / 2);
    const right = [
      pathSectionElem.referencePoint.x + pathSectionElem.rightEdge.distanceFromReferencePoint * Math.cos(angleRight),
      pathSectionElem.referencePoint.y + pathSectionElem.rightEdge.distanceFromReferencePoint * Math.sin(angleRight)
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
