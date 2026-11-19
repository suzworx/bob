/**
 * #550, #1240: device actions in a conversation's row menu appear only once a
 * device is paired. With none, the menu offers no "Use on …" at all (there is
 * nothing to move), rather than an action that can only fail. The suite never
 * revokes devices on a found stack, which may hold a real account's devices.
 * The conversation is inserted in the local database and deleted afterwards.
 */
import { randomBytes } from 'node:crypto';
import { expect, ok, test } from './fixtures.ts';
import { revokeAllDevices } from './support/fake-cardputer.ts';
import { FOUND_BASE_URL, runLocalSql, sqlText } from './stack.ts';
import { menuItem } from './components/menu.ts';

test('with no paired device, a conversation offers no device action', async ({ page, devicesPage, tag, api, userId, cleanup }) => {
  test.skip(Boolean(FOUND_BASE_URL), 'a found stack may have a real device; the suite never revokes a real device');
  await revokeAllDevices(api);

  const id = `conv_${randomBytes(8).toString('hex')}`;
  const title = `Device check ${tag}`;
  cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${id}`)));
  runLocalSql(
    `insert into bob.conversations (id, user_id, title) values (${sqlText(id)}, ${sqlText(userId)}, ${sqlText(title)});\n`,
  );

  await page.goto('/');
  await devicesPage.openDeviceMenu(title);
  await expect(menuItem(page).first()).toBeVisible();
  await expect(devicesPage.useOnCardputer).toHaveCount(0);
});
