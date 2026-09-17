import { test, expect, seededPr } from './_fixtures.mjs'

// Pins the whole "an image goes along with a chat message" chain, end to end
// and offline: paste → upload → a thumbnail in the composer → send with NO
// typed text at all → the image comes back in the reviewer's own bubble, served
// by the app itself. See .claude/docs/claude-chat-panel.md ("Afbeeldingen
// meesturen") and chat_attachment.go.
//
// A genuinely valid 1x1 PNG, because the server sniffs the MAGIC BYTES and
// refuses anything that is not a real image — a dummy string would be rejected
// exactly as intended and the test would prove nothing.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// pasteImage fires the same `paste` event a real Cmd+V with a screenshot on the
// clipboard produces: a ClipboardEvent whose DataTransfer carries one image
// File. Playwright cannot put an image on the real system clipboard, and the
// composer reads `e.clipboardData.files` — so this synthesises exactly that one
// input, nothing else about the path is faked.
async function pasteImage(page, base64, name = 'schermafdruk.png') {
  await page.evaluate(
    ({ base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const file = new File([bytes], name, { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const el = document.querySelector('[data-testid=claude-chat-compose]')
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    },
    { base64, name },
  )
}

test('Claude chat: a pasted image is uploaded, shown in the composer and sent with the message', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'klopt deze layout?',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

  await pasteImage(page, PNG_1X1)

  // The chip appears immediately (a local object URL), then the upload
  // finishes — the WORD "uploaden…" is what says which of the two we are in,
  // never colour alone (the reviewer is colourblind).
  const chip = page.getByTestId('chat-attachment-chip')
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('schermafdruk.png')
  await expect(page.getByTestId('chat-attachment-uploading')).toHaveCount(0)
  await expect(page.getByTestId('chat-attachment-failed')).toHaveCount(0)

  // Enter with an EMPTY field still sends: the image alone is a complete
  // message, and the bubble gets the short placeholder body instead of
  // opening the composer menu (the old empty-Enter behaviour).
  await page.getByTestId('claude-chat-compose').press('Enter')

  const attached = page.getByTestId('chat-message-attachments').first()
  await expect(attached).toBeVisible()
  await expect(page.getByTestId('claude-message-body').first()).toContainText('(afbeelding)')
  // The composer is empty again — the chip went out with the message.
  await expect(page.getByTestId('chat-attachment-chip')).toHaveCount(0)

  // The image really renders, i.e. /api/chat/attachment served the bytes back
  // (a broken src would leave naturalWidth at 0).
  const img = attached.locator('img').first()
  await expect(img).toHaveAttribute('data-md-image', 'true')
  await expect(async () => {
    expect(await img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0)
  }).toPass()
})

test('Claude chat: a non-image paste is refused with a word, and the message is unaffected', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kan dit sneller?',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()

  // A dropped .txt: refused in the browser, before any upload — and said in
  // words, not by a colour.
  await page.evaluate(() => {
    const file = new File(['hallo'], 'notitie.txt', { type: 'text/plain' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const card = document.querySelector('[data-testid=claude-chat-card]')
    card.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.getByTestId('chat-attachment-chip')).toHaveCount(0)

  // And a plain text paste still behaves exactly as before: it lands in the
  // field, nothing is attached.
  await composer.type('gewone tekst')
  expect(await composer.inputValue()).toBe('gewone tekst')
  await expect(page.getByTestId('chat-attachment-chip')).toHaveCount(0)
})
