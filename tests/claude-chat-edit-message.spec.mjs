import { test, expect, seededPr } from "./_fixtures.mjs";

// "Bewerk dit bericht": `e` on a keyboard-selected own bubble (or its pencil)
// puts that message back in the composer; sending replaces it and every later
// message, and the conversation continues from there — see "Bewerk dit
// bericht" in .claude/docs/claude-chat-panel.md.
test("editing an own Claude chat message drops it and everything after it", async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo);
  const start = await page.request.post("/api/workflows/task_code_comment", {
    data: {
      pr,
      file: "test.php",
      line: 1,
      author: "reviewer",
      body: "kan dit sneller?",
      code: "$order->total();",
      gran: "call",
      label: "Order::total",
    },
  });
  expect((await start.json()).runId).toBeTruthy();

  await page.goto("/pr/" + pr);
  const item = page.getByTestId("comment-item").first();
  await expect(item).toBeVisible();
  await item.click();
  await page.keyboard.press("ArrowRight"); // comment -> claude

  const composer = page.getByTestId("claude-chat-compose");
  await expect(composer).toBeFocused();
  await composer.fill("eerste versie van mijn vraag");
  await composer.press("Enter");
  const reply = page
    .getByTestId("claude-message-body")
    .filter({ hasText: "Ik heb naar de code gekeken" });
  await expect(reply).toBeVisible();
  await expect(page.getByTestId("claude-message")).toHaveCount(2);

  // The pencil sits on the own bubble only.
  await expect(page.getByTestId("claude-message-edit")).toHaveCount(1);

  await page.keyboard.press("ArrowUp"); // the reply
  await page.keyboard.press("ArrowUp"); // the own message
  const own = page
    .getByTestId("claude-message-body")
    .filter({ hasText: "eerste versie" });
  await expect(own).toHaveClass(/ring-2/);
  await page.keyboard.press("e");

  await expect(page.getByTestId("claude-editing")).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("eerste versie van mijn vraag");

  await composer.fill("tweede versie van mijn vraag");
  await composer.press("Enter");

  await expect(
    page
      .getByTestId("claude-message-body")
      .filter({ hasText: "tweede versie" }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("claude-message-body")
      .filter({ hasText: "eerste versie" }),
  ).toHaveCount(0);
  await expect(reply).toBeVisible();
  await expect(page.getByTestId("claude-message")).toHaveCount(2);
  await expect(page.getByTestId("claude-editing")).toHaveCount(0);
});

test("Escape leaves edit mode without sending", async ({ page }, testInfo) => {
  const pr = seededPr(testInfo);
  await page.request.post("/api/workflows/task_code_comment", {
    data: {
      pr,
      file: "test.php",
      line: 1,
      author: "reviewer",
      body: "kan dit sneller?",
      code: "$order->total();",
      gran: "call",
      label: "Order::total",
    },
  });
  await page.goto("/pr/" + pr);
  const item = page.getByTestId("comment-item").first();
  await expect(item).toBeVisible();
  await item.click();
  await page.keyboard.press("ArrowRight");
  const composer = page.getByTestId("claude-chat-compose");
  await expect(composer).toBeFocused();
  await composer.fill("mijn vraag");
  await composer.press("Enter");
  await expect(page.getByTestId("claude-message")).toHaveCount(2);

  await page.getByTestId("claude-message-edit").click();
  await expect(page.getByTestId("claude-editing")).toBeVisible();
  await expect(composer).toHaveValue("mijn vraag");
  await composer.press("Escape");
  await expect(page.getByTestId("claude-editing")).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("claude-message")).toHaveCount(2);
});
