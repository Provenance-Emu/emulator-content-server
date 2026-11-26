import assert from 'node:assert/strict';
import test from 'node:test';
import { icloudSettings } from '../src/icloud-defaults.js';

const BUILT_IN = 'generated-built-in';

test('the built-in token is used unless the operator says otherwise', () => {
  assert.deepEqual(icloudSettings({}, BUILT_IN), { apiToken: BUILT_IN });
  assert.equal(icloudSettings({}, ''), undefined, 'no default, no feature');
  assert.equal(icloudSettings({ ECS_ICLOUD_API_TOKEN: 'off' }, BUILT_IN), undefined);
  assert.equal(icloudSettings({ ECS_ICLOUD_API_TOKEN: ' OFF ' }, BUILT_IN), undefined);
  assert.deepEqual(icloudSettings({ ECS_ICLOUD_API_TOKEN: ' generated-own ' }, BUILT_IN), {
    apiToken: 'generated-own',
  });
});

test('the built-in token is not sent to a container or database it was not made for', () => {
  assert.equal(icloudSettings({ ECS_ICLOUD_ENVIRONMENT: 'development' }, BUILT_IN), undefined);
  assert.equal(
    icloudSettings({ ECS_ICLOUD_CONTAINER: 'iCloud.example.other' }, BUILT_IN),
    undefined,
  );
  assert.deepEqual(
    icloudSettings({ ECS_ICLOUD_CONTAINER: 'iCloud.org.provenance-emu.provenance' }, BUILT_IN),
    { apiToken: BUILT_IN, container: 'iCloud.org.provenance-emu.provenance' },
  );
  assert.deepEqual(
    icloudSettings(
      { ECS_ICLOUD_API_TOKEN: 'generated-own', ECS_ICLOUD_ENVIRONMENT: 'development' },
      BUILT_IN,
    ),
    { apiToken: 'generated-own', environment: 'development' },
  );
});
