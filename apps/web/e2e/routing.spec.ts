import { expect, test, type Page } from '@playwright/test';
import { carrierPost, newCallSid } from './carrier';
import { E2E } from '../playwright.config';

async function register(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Business name').fill('E2E Routing');
  await page.getByLabel('Work email').fill(`e2e-routing-${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/app\/numbers$/);
}

async function csrf(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === 'relay_csrf')?.value ?? '';
}

test('campaign with two tiers: first target misses, the call fails over and connects', async ({
  page,
  request,
}) => {
  await register(page);

  // Buy a number (API; the buy flow has its own E2E test).
  const token = await csrf(page);
  const available = await (
    await page.request.get('/api/v1/numbers/available?prefix=844&limit=1')
  ).json();
  const bought = await page.request.post('/api/v1/numbers', {
    data: { e164: available.data[0].e164 },
    headers: { 'x-csrf-token': token },
  });
  const e164: string = (await bought.json()).data.e164;

  // 1. Create the campaign.
  await page.getByRole('link', { name: 'Campaigns' }).click();
  await page.getByRole('button', { name: 'New campaign' }).click();
  await page.getByLabel('Name').fill('Support line');
  await page.getByRole('button', { name: 'Create campaign' }).click();
  await expect(page.getByRole('heading', { name: 'Support line' })).toBeVisible();

  // 2. Add a tier-1 and a tier-2 target.
  const addTarget = async (name: string, phone: string, tier: string) => {
    await page.getByRole('button', { name: 'Add target' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Phone number').fill(phone);
    await dialog.getByLabel('Tier').fill(tier);
    await dialog.getByRole('button', { name: 'Add target' }).click();
    await expect(page.getByText(`Added ${name}`)).toBeVisible();
  };
  await addTarget('Front desk', '+14155550101', '1');
  await addTarget('On-call phone', '+14155550102', '2');
  await expect(page.getByRole('heading', { name: 'Tier 2' })).toBeVisible();

  // 3. Attach the number.
  await page.getByRole('tab', { name: 'Numbers' }).click();
  await page.getByRole('combobox', { name: 'Number' }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Attach' }).click();
  await expect(page.getByText('Number attached')).toBeVisible();

  // 4. The dry run says tier 1 would ring.
  await page.getByRole('tab', { name: 'Test routing' }).click();
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByText('tier 1 would ring.')).toBeVisible();

  // 5. A call arrives; the front desk does not answer; the on-call phone does.
  const sid = newCallSid();
  const first = await (
    await carrierPost(request, '/voice/inbound', { CallSid: sid, From: '+13125550187', To: e164 })
  ).text();
  expect(first).toContain('>+14155550101</Number>');
  const legUrl = (twiml: string) =>
    /statusCallback="([^"]+)"/.exec(twiml)![1]!.replace(/&amp;/g, '&').replace(E2E.apiUrl, '');
  const second = await (
    await carrierPost(request, '/voice/result?attempt=1', {
      CallSid: sid,
      DialCallStatus: 'no-answer',
    })
  ).text();
  expect(second).toContain('>+14155550102</Number>');
  await carrierPost(request, legUrl(second), {
    CallSid: 'CAe2eleg',
    ParentCallSid: sid,
    CallStatus: 'in-progress',
  });

  // 6. Live calls shows it connected to the on-call phone.
  await page.getByRole('link', { name: 'Live calls' }).click();
  const liveRow = page.getByRole('row').filter({ hasText: '+1 (312) 555-0187' });
  await expect(liveRow).toContainText('Connected', { timeout: 5_000 });
  await expect(liveRow).toContainText('On-call phone');

  await carrierPost(request, '/voice/result?attempt=2', {
    CallSid: sid,
    DialCallStatus: 'completed',
    DialCallDuration: '95',
    DialCallSid: 'CAe2eleg',
  });
  await expect(page.getByText('No calls in progress')).toBeVisible({ timeout: 5_000 });

  // 7. Call detail shows both attempts and, for the owner, why.
  await page.getByRole('link', { name: 'Call log' }).click();
  await page.getByRole('row').filter({ hasText: '+1 (312) 555-0187' }).getByRole('link').click();
  await expect(page.getByText('Attempt 1: tier 1, one at a time')).toBeVisible();
  await expect(page.getByText('Attempt 2: tier 2, one at a time')).toBeVisible();
  await expect(page.getByText('Answered for 1m 35s')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Why it was routed this way' })).toBeVisible();
  await expect(page.getByText('Already rung on this call')).toBeVisible();
});
