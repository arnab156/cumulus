const fs = require('fs');
const path = require('path');
const {
  aws: {
    headObject,
    parseS3Uri,
    s3,
    s3ObjectExists
  },
  stringUtils: { globalReplace },
  testUtils: {
    randomString
  }
} = require('@cumulus/common');
const { api: apiTestUtils, buildAndExecuteWorkflow, LambdaStep } = require('@cumulus/integration-tests');
const { Execution } = require('@cumulus/api/models');
const {
  loadConfig,
  templateFile,
  uploadTestDataToBucket,
  timestampedTestDataPrefix,
  deleteFolder
} = require('../helpers/testUtils');
const {
  setupTestGranuleForIngest,
  loadFileWithUpdatedGranuleId
} = require('../helpers/granuleUtils');

const config = loadConfig();
const lambdaStep = new LambdaStep();
const workflowName = 'SyncGranule';

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

describe('When the Sync Granules workflow is configured to overwrite data with duplicate filenames', () => {
  const testDataFolder = timestampedTestDataPrefix(`${config.stackName}-SyncGranuleSuccess`);
  const inputPayloadFilename = './spec/syncGranule/SyncGranule.input.payload.json';
  let inputPayload;
  let expectedPayload;
  const collection = { name: 'MOD09GQ', version: '006' };
  const provider = { id: 's3_provider' };
  let workflowExecution;

  process.env.ExecutionsTable = `${config.stackName}-ExecutionsTable`;
  const executionModel = new Execution();

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

  describe('the SyncGranule Lambda function', () => {
    let lambdaOutput = null;
    let files;
    let key1;
    let key2;
    const existCheck = [];

    beforeAll(async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'SyncGranule');
      files = lambdaOutput.payload.granules[0].files;
      key1 = path.join(files[0].fileStagingDir, files[0].name);
      key2 = path.join(files[1].fileStagingDir, files[1].name);
      existCheck[0] = await s3ObjectExists({ Bucket: files[0].bucket, Key: key1 });
      existCheck[1] = await s3ObjectExists({ Bucket: files[1].bucket, Key: key2 });
    });

    it('receives payload with file objects updated to include file staging location', () => {
      expect(lambdaOutput.payload).toEqual(expectedPayload);
    });

    // eslint-disable-next-line max-len
    it('receives meta.input_granules with files objects updated to include file staging location', () => {
      expect(lambdaOutput.meta.input_granules).toEqual(expectedPayload.granules);
    });

    it('receives files with custom staging directory', () => {
      files.forEach((file) => {
        expect(file.fileStagingDir).toMatch('custom-staging-dir\/.*');
      });
    });

    it('adds files to staging location', () => {
      existCheck.forEach((check) => {
        expect(check).toEqual(true);
      });
    });
  });

  describe('the sf-sns-report task has published a sns message and', () => {
    it('the execution record is added to DynamoDB', async () => {
      const record = await executionModel.get({ arn: workflowExecution.executionArn });
      expect(record.status).toEqual('completed');
    });
  });

  describe('and it encounters data with a duplicated filename', () => {
    let lambdaOutput;
    let existingfiles;
    let fileUpdated;

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
      fileUpdated = file.name;
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

    it('overwrites the existing file with the new data', async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'SyncGranule');
      const files = lambdaOutput.payload.granules[0].files;

      const currentFiles = await Promise.all(files.map(async (f) => {
        const header = await headObject(f.bucket, parseS3Uri(f.filename).Key);
        return { filename: f.filename, fileSize: header.ContentLength, LastModified: header.LastModified };
      }));

      expect(currentFiles.length).toBe(existingfiles.length);

      currentFiles.forEach((cf) => {
        const existingfile = existingfiles.filter((ef) => ef.filename === cf.filename);
        expect(cf.LastModified).toBeGreaterThan(existingfile[0].LastModified);
        if (cf.filename.endsWith(fileUpdated)) {
          expect(cf.fileSize).toBe(inputPayload.granules[0].files[0].fileSize);
        }
      });
    });
  });
});
