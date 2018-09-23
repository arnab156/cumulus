'use strict';

const path = require('path');
const cumulusMessageAdapter = require('@cumulus/cumulus-message-adapter-js');
const errors = require('@cumulus/common/errors');
const lock = require('@cumulus/ingest/lock');
const granule = require('@cumulus/ingest/granule');
const log = require('@cumulus/common/log');

/**
 * Ingest a list of granules
 *
 * @param {Object} ingest - an ingest object
 * @param {string} bucket - the name of an S3 bucket, used for locking
 * @param {string} provider - the name of a provider, used for locking
 * @param {Object[]} granules - the granules to be ingested
 * @returns {Promise.<Array>} - the list of successfully ingested granules
 */
async function download(ingest, bucket, provider, files) {
  const updatedGranules = [];

  log.debug(`awaiting lock.proceed in download() bucket: ${bucket}, `
            + `provider: ${JSON.stringify(provider)}, file: ${files[0].filename}`);
  const proceed = await lock.proceed(bucket, provider, files[0].filename);

  if (!proceed) {
    const err =
      new errors.ResourcesLockedError('Download lock remained in place after multiple tries');
    log.error(err);
    throw err;
  }

  for (const f of files) {
    try {
      log.debug(`await ingest.ingest(${JSON.stringify(f)}, ${bucket})`);
      const r = await ingest.ingest(f, bucket);
      updatedGranules.push(r);
    }
    catch (e) {
      log.debug(`Error caught, await lock.removeLock(${bucket}, ${provider.id}, ${f.filename})`);
      await lock.removeLock(bucket, provider.host, f.filename);
      log.error(e);
      throw e;
    }
  }
  log.debug(`finshed, await lock.removeLock(${bucket}, ${provider.host}, ${files[0].filename})`);
  await lock.removeLock(bucket, provider.host, files[0].filename);
  return updatedGranules;
}

/**
 * Ingest a list of granules
 *
 * @param {Object} event - contains input and config parameters
 * @returns {Promise.<Object>} - a description of the ingested granules
 */
exports.syncGranule = function syncGranule(event) {
  const config = event.config;
  const input = event.input;
  const stack = config.stack;
  const buckets = config.buckets;
  const forceDownload = config.forceDownload || false;
  const downloadBucket = config.downloadBucket;
  const provider = config.provider;
  const protocol = provider.protocol;
  let duplicateHandling = config.duplicateHandling;
  const collection = config.collection || {};
  if (!duplicateHandling && collection && collection.duplicateHandling) {
    duplicateHandling = collection.duplicateHandling;
  }

  // use stack and collection names to prefix fileStagingDir
  const fileStagingDir = path.join(
    (config.fileStagingDir || 'file-staging'),
    stack
  );

  const IngestClass = granule.selector('ingest', protocol);
  const ingest = new IngestClass(
    buckets,
    collection,
    provider,
    fileStagingDir,
    forceDownload,
    duplicateHandling
  );

  return download(ingest, downloadBucket, provider, input.files)
    .then((granules) => {
      if (ingest.end) ingest.end();
      const output = { granules };
      if (collection && collection.process) output.process = collection.process;
      if (config.pdr) output.pdr = config.pdr;
      log.debug(`SyncGranule Complete. Returning output: ${JSON.stringify(output)}`);
      return output;
    }).catch((e) => {
      log.debug('SyncGranule errored.');
      if (ingest.end) ingest.end();

      let errorToThrow = e;
      if (e.toString().includes('ECONNREFUSED')) {
        errorToThrow = new errors.RemoteResourceError('Connection Refused');
      }
      else if (e.details && e.details.status === 'timeout') {
        errorToThrow = new errors.ConnectionTimeout('connection Timed out');
      }

      log.error(errorToThrow);
      throw errorToThrow;
    });
};

/**
 * Lambda handler
 *
 * @param {Object} event - a Cumulus Message
 * @param {Object} context - an AWS Lambda context
 * @param {Function} callback - an AWS Lambda handler
 * @returns {undefined} - does not return a value
 */
exports.handler = function handler(event, context, callback) {
  const startTime = Date.now();

  cumulusMessageAdapter.runCumulusTask(exports.syncGranule, event, context, (err, data) => {
    if (err) {
      callback(err);
    }
    else {
      const endTime = Date.now();
      const additionalMetaFields = {
        sync_granule_duration: endTime - startTime,
        sync_granule_end_time: endTime
      };
      const meta = Object.assign({}, data.meta, additionalMetaFields);
      callback(null, Object.assign({}, data, { meta }));
    }
  });
};
