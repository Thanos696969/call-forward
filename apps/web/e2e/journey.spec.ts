import { expect, test } from '@playwright/test';
import { carrierPost, newCallSid } from './carrier';

test('signup → buy number → set destination → simulated call → call in log and dashboard', async ({
  page,
  request,
}) => {
  const email = `e2e-${Date.now()}@example.test`;

  // 1. Register from the landing page.
  await page.goto('/');
  await page.getByRole('link', { name: 'Create account' }).first().click();
  await expect(page.getByRole('heading', { name: 'Create your Relay account' })).toBeVisible();
  await page.getByLabel('Business name').fill('E2E Plumbing');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/app\/numbers$/);
  await expect(page.getByText("You don't have a number yet")).toBeVisible();

  // 2. Buy a number from the searchable inventory.
  await page.getByRole('button', { name: 'Buy number' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Buy a toll-free number' })).toBeVisible();
  await dialog.getByLabel('Prefix').selectOption('800');
  await dialog.getByRole('button', { name: 'Search' }).click();
  const firstNumber = dialog.getByRole('listitem').first().getByRole('button');
  await expect(firstNumber).toBeVisible();
  await firstNumber.click();
  await expect(page).toHaveURL(/\/app\/numbers\/[0-9a-f-]{36}$/);
  const numberId = page.url().split('/').pop() ?? '';

  // 3. Set the destination, ring timeout and enabled toggle, then save.
  await page.getByLabel('Destination phone').fill('+14155550123');
  await page.getByLabel('Ring for (seconds)').fill('20');
  await expect(page.getByRole('switch', { name: 'Forward calls' })).toHaveAttribute(
    'data-state',
    'checked',
  );
  await page.getByRole('button', { name: 'Save forwarding' }).click();
  await expect(page.getByText('Calls now ring +1 (415) 555-0123')).toBeVisible();

  // 4. A call arrives (simulated carrier webhooks against the real API).
  const number = await (await page.request.get(`/api/v1/numbers/${numberId}`)).json();
  const e164: string = number.data.e164;
  const callSid = newCallSid();
  const inbound = await carrierPost(request, '/voice/inbound', {
    CallSid: callSid,
    From: '+13125550187',
    To: e164,
  });
  expect(inbound.status()).toBe(200);
  expect(await inbound.text()).toContain('>+14155550123</Number>');
  const result = await carrierPost(request, '/voice/result', {
    CallSid: callSid,
    DialCallStatus: 'completed',
    DialCallDuration: '73',
  });
  expect(result.status()).toBe(200);

  // 5. The call shows up within 5 seconds: on the number, in the log and on the dashboard.
  await expect(page.getByRole('cell', { name: '+1 (312) 555-0187' })).toBeVisible({
    timeout: 5_000,
  });

  await page.getByRole('link', { name: 'Call log' }).click();
  const row = page.getByRole('row').filter({ hasText: '+1 (312) 555-0187' });
  await expect(row).toBeVisible({ timeout: 5_000 });
  await expect(row).toContainText('Answered');
  await expect(row).toContainText('1m 13s');
  await expect(row).toContainText('+1 (415) 555-0123');

  await row.getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Call from +1 (312) 555-0187' })).toBeVisible();
  await expect(page.getByText('Attempt 1: tier 1, one at a time')).toBeVisible();
  await expect(page.getByText('Answered for 1m 13s')).toBeVisible();

  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByText('Answer rate')).toBeVisible();
  await expect(page.getByText('100%')).toBeVisible({ timeout: 5_000 });

  // Clean up: release the number through the UI so the mock inventory is reusable.
  await page.goto(`/app/numbers/${numberId}`);
  await page.getByRole('button', { name: 'Release number' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Release number' }).click();
  await expect(page).toHaveURL(/\/app\/numbers$/);
});

test('signed-out visitors are sent to sign in', async ({ page }) => {
  await page.goto('/app/calls');
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fcalls/);
  await expect(page.getByRole('heading', { name: 'Sign in to Relay' })).toBeVisible();
});
