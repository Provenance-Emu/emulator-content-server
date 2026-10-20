import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseFolder, folderName, validateFolderSelection } from '../src/lib/folder-selection.js';
import { selection } from './folder-fixture.js';

test('automatic names support Windows, POSIX, trailing separators and volume roots', () => {
  for (const [path, expected] of [
    ['/srv/Arcade/', 'Arcade'],
    ['C:\\Games\\Saves\\', 'Saves'],
    ['C:\\', 'C:'],
    ['/', 'Server folder'],
  ] as const)
    assert.equal(folderName(path), expected);
});
test('native cancellation never submits and a stale selection never validates', async () => {
  let validations = 0;
  const context = {
    key: 'epoch',
    origin: 'http://server.test',
    folderSelection: {
      async choose() {
        return null;
      },
      async validate() {
        validations++;
        return true;
      },
    },
  };
  assert.equal(await chooseFolder(context, 'library-folder'), null);
  assert.equal(validations, 0);
  assert.equal(
    await validateFolderSelection({ ...selection(), contextKey: 'old' }, context),
    false,
  );
});
test('context replacement during native verification blocks submission', async () => {
  const context = {
    key: 'epoch',
    origin: 'http://server.test',
    folderSelection: {
      async choose() {
        return selection();
      },
      async validate() {
        context.key = 'replacement';
        return true;
      },
    },
  };
  assert.equal(await chooseFolder(context, 'library-folder'), null);
});
