import { test, expect } from './_fixtures.mjs'

// The "Zoek startpunten…" box matches a row's label, its category AND its file
// path (searchHaystack/recomputeLeftList, home.mjs) — reviewer request: "ik wil
// ook op bestandsnaam kunnen zoeken". A test_class row, which stands in for
// several methods, also matches on any of its methods' label/category/file.
// Fixture: the main PR 12903 blocks (tests/fixtures/blocks.json).
test.describe('PR Review Tree — searching startpunten by file path', () => {
  test('a path fragment filters the list, a directory name too, and a class name still works', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(11)
    const box = page.getByTestId('block-search')

    // A path fragment that appears in NO label: only the two blocks in
    // app/Models/ survive (Address::billingAddress, Order::address).
    await box.fill('app/Models')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Address::billingAddress')
    await expect(rows.nth(1)).toContainText('Order::address')

    // A bare directory name works the same way.
    await box.fill('migrations')
    await expect(rows).toHaveCount(1)
    await expect(rows.nth(0)).toContainText('up')

    // A test_class row has no file of its own — it matches through its
    // grouped method's path (tests/Feature/Addresses/AddressTypeTest.php).
    await box.fill('Feature/Addresses')
    await expect(rows).toHaveCount(1)
    await expect(rows.nth(0)).toContainText('AddressTypeTest')

    // Matching on the label itself is unchanged.
    await box.fill('billingAddress')
    await expect(rows).toHaveCount(1)
    await expect(rows.nth(0)).toContainText('Address::billingAddress')

    // Clearing brings everything back.
    await box.fill('')
    await expect(rows).toHaveCount(11)
  })
})
