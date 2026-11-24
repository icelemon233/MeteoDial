'use strict';
module.exports = {
  ...require('./satellite.cjs'),
  ...require('./radar.cjs'),
  ...require('./cyclones.cjs'),
  observationTimes: require('./gibs.cjs').observationTimes,
};
