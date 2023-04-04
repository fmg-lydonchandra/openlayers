import JSONFeature from './JSONFeature.js';
import {get as getProjection} from '../proj.js';
import TopoJSON from './TopoJSON.js';
import Feature from '../Feature.js';
import {LineString} from '../geom.js';

class PtclJSON extends JSONFeature {
  constructor(options) {
    super();
    options = options ? options : {};
    this.layerName_ = options.layerName;
    this.layers_ = options.layers ? options.layers : null;
    this.dataProjection = getProjection(
      options.dataProjection ? options.dataProjection : 'EPSG:4326'
    );
  }

  readFeatureFromObject(object, options) {
    return undefined;
  }

  readFeaturesFromObject(object, options) {
    options = options ? options : {};
    let features = [];

    if (!object.AreaMapDePtr.pathSections) {
      return features;
    }
    let centreLines = [];

    for (let i = 0, ii = object.AreaMapDePtr.pathSections.length; i < ii; i++) {
      const pathSec = object.AreaMapDePtr.pathSections[i];
      const feature = new Feature();
      for (let j = 0; j < pathSec.numElements; j++) {
        const elem = pathSec.elements[j];
        const centerPoint = [
          elem.referencePoint.x / 1000,
          elem.referencePoint.y / 1000,
        ];
        centreLines.push(centerPoint);
      }
      const geom = new LineString(centreLines);
      feature.setGeometry(geom);
      features.push(feature);
    }
    console.log(features)
    return features;
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
