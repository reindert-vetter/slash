import { test, expect, seededPr } from './_fixtures.mjs'

// Verifies: everywhere renderMarkdown (markdown.mjs) renders — here a comment
// body — two consecutive images with no text between them render side by
// side in a flex row (enhanceImages), and clicking either one opens a
// fullscreen lightbox that →/← cycles through, wrapping around, with Escape
// to close. "Overal waar markdown staat" (reviewer's explicit answer) means
// this is ONE mechanism (src/imageLightbox.mjs), so a single comment-body
// spec is enough to cover the wiring end to end; every other render point
// (PR description, Claude-chat bubbles) shares the
// exact same `.markdown-body` scoping hook and needs no separate wiring.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const IMG1 = `data:image/png;base64,${PIXEL}#one`
const IMG2 = `data:image/png;base64,${PIXEL}#two`

test('two consecutive comment images sit side by side and open in a cyclable fullscreen lightbox', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: `zie de screenshots:\n\n![eerste](${IMG1})\n![tweede](${IMG2})`,
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await page.keyboard.press('Escape')
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  const images = item.locator('img[data-md-image]')
  await expect(images).toHaveCount(2)

  // No text sits between the two images, so they share one flex-row wrapper
  // instead of stacking one huge image per line.
  const wrapperClass = await images.first().evaluate((el) => el.parentElement.className)
  expect(wrapperClass).toContain('flex')

  await images.first().click()
  const lightbox = page.getByTestId('image-lightbox')
  await expect(lightbox).toBeVisible()
  const shownImage = page.getByTestId('image-lightbox-image')
  await expect(shownImage).toHaveAttribute('src', IMG1)
  await expect(page.getByTestId('image-lightbox-counter')).toHaveText('1 / 2')

  await page.keyboard.press('ArrowRight')
  await expect(shownImage).toHaveAttribute('src', IMG2)
  await expect(page.getByTestId('image-lightbox-counter')).toHaveText('2 / 2')

  // Wraps back around to the first image.
  await page.keyboard.press('ArrowRight')
  await expect(shownImage).toHaveAttribute('src', IMG1)
  await expect(page.getByTestId('image-lightbox-counter')).toHaveText('1 / 2')

  // ← also cycles (backwards, so from the first it wraps to the last).
  await page.keyboard.press('ArrowLeft')
  await expect(shownImage).toHaveAttribute('src', IMG2)

  await page.keyboard.press('Escape')
  await expect(lightbox).toHaveCount(0)

  // The rest of the app's own keyboard navigation is untouched once closed —
  // Escape here must not have been swallowed by anything else either.
  await expect(item).toBeVisible()
})
