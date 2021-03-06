const fs = require('fs');
const path = require('path');
const {
  aws: {
    headObject,
    parseS3Uri,
    s3
  },
  stringUtils: { globalReplace },
  testUtils: {
    randomString
  }
} = require('@cumulus/common');
const { api: apiTestUtils, buildAndExecuteWorkflow, LambdaStep } = require('@cumulus/integration-tests');
const {
  deleteFolder,
  loadConfig,
  templateFile,
  timestampedTestDataPrefix,
  uploadTestDataToBucket
} = require('../helpers/testUtils');
const {
  loadFileWithUpdatedGranuleId,
  setupTestGranuleForIngest
} = require('../helpers/granuleUtils');
const config = loadConfig();
const lambdaStep = new LambdaStep();
const workflowName = 'SyncGranuleDuplicateSkipTest';

const granuleRegex = '^MOD09GQ\\.A[\\d]{7}\\.[\\w]{6}\\.006\\.[\\d]{13}$';
const testDataGranuleId = 'MOD09GQ.A2016358.h13v04.006.2016360104606';

const outputPayloadTemplateFilename = './spec/syncGranule/SyncGranule.output.payload.template.json';
const templatedOutputPayloadFilename = templateFile({
  inputTemplateFilename: outputPayloadTemplateFilename,
  config: config.SyncGranule
});

const s3data = [
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606_ndvi.jpg'
];

describe('When the Sync Granule workflow is configured to skip new data when encountering duplicate filenames', () => {
  const testDataFolder = timestampedTestDataPrefix(`${config.stackName}-SyncGranuleDuplicateHandlingSkip`);
  const inputPayloadFilename = './spec/syncGranule/SyncGranule.input.payload.json';
  let inputPayload;
  let expectedPayload;
  const collection = { name: 'MOD09GQ', version: '006' };
  const provider = { id: 's3_provider' };
  let workflowExecution;

  beforeAll(async () => {
    // upload test data
    await uploadTestDataToBucket(config.bucket, s3data, testDataFolder);

    const inputPayloadJson = fs.readFileSync(inputPayloadFilename, 'utf8');

    // update test data filepaths
    const updatedInputPayloadJson = globalReplace(inputPayloadJson, 'cumulus-test-data/pdrs', testDataFolder);
    inputPayload = await setupTestGranuleForIngest(config.bucket, updatedInputPayloadJson, testDataGranuleId, granuleRegex);

    const granuleId = inputPayload.granules[0].granuleId;
    const updatedOutputPayload = loadFileWithUpdatedGranuleId(templatedOutputPayloadFilename, testDataGranuleId, granuleId);
    // update test data filepaths
    expectedPayload = JSON.parse(globalReplace(JSON.stringify(updatedOutputPayload), 'cumulus-test-data/pdrs', testDataFolder));

    workflowExecution = await buildAndExecuteWorkflow(
      config.stackName, config.bucket, workflowName, collection, provider, inputPayload
    );
  });

  afterAll(async () => {
    // Remove the granule files added for the test
    await deleteFolder(config.bucket, testDataFolder);

    // delete ingested granule
    await apiTestUtils.deleteGranule({
      prefix: config.stackName,
      granuleId: inputPayload.granules[0].granuleId
    });
  });

  it('completes execution with success status', () => {
    expect(workflowExecution.status).toEqual('SUCCEEDED');
  });

  describe('and it encounters data with a duplicated filename', () => {
    let lambdaOutput;
    let existingfiles;

    beforeAll(async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'SyncGranule');
      const files = lambdaOutput.payload.granules[0].files;
      existingfiles = await Promise.all(files.map(async (f) => {
        const header = await headObject(f.bucket, parseS3Uri(f.filename).Key);
        return { filename: f.filename, fileSize: header.ContentLength, LastModified: header.LastModified };
      }));

      // update one of the input files, so that the file has different checksum
      const content = randomString();
      const file = inputPayload.granules[0].files[0];
      const updateParams = {
        Bucket: config.bucket, Key: path.join(file.path, file.name), Body: content
      };

      await s3().putObject(updateParams).promise();
      inputPayload.granules[0].files[0].fileSize = content.length;

      workflowExecution = await buildAndExecuteWorkflow(
        config.stackName, config.bucket, workflowName, collection, provider, inputPayload
      );
    });

    it('does not raise a workflow error', () => {
      expect(workflowExecution.status).toEqual('SUCCEEDED');
    });

    it('does not overwrite existing file or create a copy of new file', async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'SyncGranule');
      const files = lambdaOutput.payload.granules[0].files;

      const currentFiles = await Promise.all(files.map(async (f) => {
        const header = await headObject(f.bucket, parseS3Uri(f.filename).Key);
        return { filename: f.filename, fileSize: header.ContentLength, LastModified: header.LastModified };
      }));

      expect(currentFiles).toEqual(existingfiles);
      expect(lambdaOutput.payload).toEqual(expectedPayload);
    });
  });
});
