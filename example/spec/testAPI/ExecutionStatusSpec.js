'use strict';

const { difference, intersection } = require('lodash');
const fs = require('fs-extra');
const {
  loadConfig,
  timestampedTestDataPrefix,
  uploadTestDataToBucket,
  deleteFolder
} = require('../helpers/testUtils');
const { getConfigObject } = require('../helpers/configUtils');
const { stringUtils: { globalReplace } } = require('@cumulus/common');
const { setupTestGranuleForIngest } = require('../helpers/granuleUtils');
const { buildAndExecuteWorkflow } = require('@cumulus/integration-tests');
const config = loadConfig();
const workflowName = 'IngestGranule';
const granuleRegex = '^MOD09GQ\\.A[\\d]{7}\\.[\\w]{6}\\.006\\.[\\d]{13}$';
const testDataGranuleId = 'MOD09GQ.A2016358.h13v04.006.2016360104606';
const { api: apiTestUtils } = require('@cumulus/integration-tests');

const workflowConfigFile = './workflows/sips.yml';

const s3data = [
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606_ndvi.jpg'
];

// all states defined in the workflow configuration
let allStates;

describe('The Cumulus API ExecutionStatus tests. The Ingest workflow', () => {
  const testDataFolder = timestampedTestDataPrefix(`${config.stackName}-ExecutionStatus`);
  let workflowExecution = null;
  const collection = { name: 'MOD09GQ', version: '006' };
  const provider = { id: 's3_provider' };
  const inputPayloadFilename = './spec/testAPI/testAPI.input.payload.json';
  let inputPayload;
  process.env.ExecutionsTable = `${config.stackName}-ExecutionsTable`;
  process.env.GranulesTable = `${config.stackName}-GranulesTable`;
  process.env.UsersTable = `${config.stackName}-UsersTable`;

  beforeAll(async () => {
    // upload test data
    await uploadTestDataToBucket(config.bucket, s3data, testDataFolder, true);

    const workflowConfig = getConfigObject(workflowConfigFile, workflowName);
    allStates = Object.keys(workflowConfig.States);

    const inputPayloadJson = fs.readFileSync(inputPayloadFilename, 'utf8');
    const updatedInputPayloadJson = globalReplace(inputPayloadJson, 'cumulus-test-data/pdrs', testDataFolder);
    inputPayload = await setupTestGranuleForIngest(config.bucket, updatedInputPayloadJson, testDataGranuleId, granuleRegex);

    workflowExecution = await buildAndExecuteWorkflow(
      config.stackName, config.bucket, workflowName, collection, provider, inputPayload
    );
  });

  afterAll(async () => {
    // Remove the granule files added for the test
    await deleteFolder(config.bucket, testDataFolder);
  });

  it('completes execution with success status', () => {
    expect(workflowExecution.status).toEqual('SUCCEEDED');
  });

  describe('When accessing a workflow execution via the API', () => {
    let executionStatus;

    beforeAll(async () => {
      const executionArn = workflowExecution.executionArn;
      executionStatus = await apiTestUtils.getExecutionStatus({
        prefix: config.stackName,
        arn: executionArn
      });
    });

    it('returns the inputs and outputs for the entire workflow', async () => {
      expect(executionStatus.execution).toBeTruthy();
      expect(executionStatus.execution.executionArn).toEqual(workflowExecution.executionArn);
      const input = JSON.parse(executionStatus.execution.input);
      const output = JSON.parse(executionStatus.execution.output);
      expect(input.payload).toEqual(inputPayload);
      expect(output.payload || output.replace).toBeTruthy();
    });

    it('returns the stateMachine information and workflow definition', async () => {
      expect(executionStatus.stateMachine).toBeTruthy();
      expect(executionStatus.stateMachine.stateMachineArn).toEqual(executionStatus.execution.stateMachineArn);
      expect(executionStatus.stateMachine.stateMachineArn.endsWith(executionStatus.stateMachine.name)).toBe(true);

      const definition = JSON.parse(executionStatus.stateMachine.definition);
      expect(definition.Comment).toEqual('Ingest Granule');
      const stateNames = Object.keys(definition.States);

      // definition has all the states' information
      expect(difference(allStates, stateNames).length).toBe(0);
    });

    it('returns the inputs and outputs for each executed step', async () => {
      expect(executionStatus.executionHistory).toBeTruthy();

      // expected 'not executed' steps
      const expectedNotExecutedSteps = ['SyncGranule', 'WorkflowFailed'];

      // expected 'executed' steps
      const expectedExecutedSteps = difference(allStates, expectedNotExecutedSteps);

      // steps with *EventDetails will have the input/output, and also stepname when state is entered/exited
      const stepNames = [];
      executionStatus.executionHistory.events.forEach((event) => {
        const eventKeys = Object.keys(event);
        if (intersection(eventKeys, ['input', 'output']).length === 1) stepNames.push(event.name);
      });

      // all the executed steps have *EventDetails
      expect(difference(expectedExecutedSteps, stepNames).length).toBe(0);
      // some steps are not executed
      expect(difference(expectedNotExecutedSteps, stepNames).length).toBe(expectedNotExecutedSteps.length);
    });
  });
});
