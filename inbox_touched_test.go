package main

import (
	"reflect"
	"testing"
)

func TestClassifyTouched(t *testing.T) {
	mig, api := classifyTouched([]string{
		"database/migrations/2026_01_01_000000_add_x.php",
		"modules/Forms/Database/Migrations/2026_create_forms.php",
		"routes/api.php",
		"modules/Pages/Routes/web.php",
		"modules/Payments/Http/Routes/api.php",
		"app/Http/Controllers/OrderController.php",
		"modules/Auth/Http/Requests/LoginRequest.php",
		"app/Http/Resources/OrderResource.php",
		// not API: nwidart's module Resources dir holds views/lang
		"modules/Forms/Resources/views/form.blade.php",
		// not API: a *Controller.php outside Http/Controllers
		"app/Http/Middleware/Version/ReplaceController.php",
		// tests are ignored entirely
		"tests/Feature/Http/Controllers/OrderControllerTest.php",
		"modules/Forms/Tests/Database/Migrations/fake.php",
		"app/Models/Order.php",
	})
	wantMig := []string{
		"database/migrations/2026_01_01_000000_add_x.php",
		"modules/Forms/Database/Migrations/2026_create_forms.php",
	}
	wantAPI := []string{
		"routes/api.php",
		"modules/Pages/Routes/web.php",
		"modules/Payments/Http/Routes/api.php",
		"app/Http/Controllers/OrderController.php",
		"modules/Auth/Http/Requests/LoginRequest.php",
		"app/Http/Resources/OrderResource.php",
	}
	if !reflect.DeepEqual(mig, wantMig) {
		t.Errorf("migrations = %v, want %v", mig, wantMig)
	}
	if !reflect.DeepEqual(api, wantAPI) {
		t.Errorf("api = %v, want %v", api, wantAPI)
	}
}

func TestFilterTouchedSection(t *testing.T) {
	sections := []inboxSection{
		{Title: "Needs your review", PRs: []inboxRow{{Number: 1}}},
		{Title: touchedSectionTitle, PRs: []inboxRow{{Number: 2}, {Number: 3}, {Number: 4}}},
	}
	statuses := map[string]prStatus{
		statusKey("", 1): {},
		statusKey("", 2): {MigrationFiles: []string{"database/migrations/x.php"}},
		statusKey("", 3): {},
		statusKey("", 4): {APIFiles: []string{"routes/api.php"}},
	}
	got := filterTouchedSection(sections, statuses)
	if n := len(got[0].PRs); n != 1 {
		t.Fatalf("other section touched: %d rows", n)
	}
	var nums []int
	for _, r := range got[1].PRs {
		nums = append(nums, r.Number)
	}
	if !reflect.DeepEqual(nums, []int{2, 4}) {
		t.Errorf("touched section = %v, want [2 4]", nums)
	}
	if _, ok := statuses[statusKey("", 3)]; ok {
		t.Errorf("status of dropped candidate 3 still present")
	}
	if _, ok := statuses[statusKey("", 1)]; !ok {
		t.Errorf("status of a row in another section was dropped")
	}
}
