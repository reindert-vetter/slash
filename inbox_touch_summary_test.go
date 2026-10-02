package main

import (
	"reflect"
	"testing"
)

func TestSummarizeMigrationAlter(t *testing.T) {
	patch := `@@ -0,0 +1,20 @@
+<?php
+return new class extends Migration {
+    public function up(): void
+    {
+        Schema::table('orders', function (Blueprint $table) {
+            $table->string('external_ref')->nullable();
+            $table->boolean('is_test')->default(false);
+            $table->integer('amount')->change();
+            $table->renameColumn('note', 'remark');
+            $table->dropColumn(['legacy_a', 'legacy_b']);
+            $table->index('external_ref');
+        });
+    }
+    public function down(): void
+    {
+        Schema::table('orders', function (Blueprint $table) {
+            $table->dropColumn('external_ref');
+        });
+    }
+};`
	got := summarizeTouched([]touchedFile{{Path: "database/migrations/2026_09_01_120000_alter_orders.php", Status: "added", Patch: patch}})
	want := &touchSummary{DB: []touchItem{{
		Kind: "alter", Name: "orders",
		Add: []string{"external_ref", "is_test"},
		Del: []string{"legacy_a", "legacy_b"},
		Chg: []string{"amount", "note → remark"},
	}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestSummarizeMigrationCreateDropRenameAndData(t *testing.T) {
	files := []touchedFile{
		{Path: "database/migrations/2026_09_01_000001_create_forms.php", Status: "added", Patch: "+        Schema::connection('clickhouse')->create('forms', function (Blueprint $table) {\n+            $table->id();\n"},
		{Path: "database/migrations/2026_09_01_000002_drop_old.php", Status: "added", Patch: "+        Schema::dropIfExists('old_things');\n+        Schema::rename('a', 'b');\n"},
		{Path: "database/migrations/2026_09_01_000003_backfill_totals.php", Status: "added", Patch: "+        DB::table('orders')->update(['x' => 1]);\n"},
	}
	got := summarizeTouched(files)
	want := &touchSummary{DB: []touchItem{
		{Kind: "create", Name: "forms"},
		{Kind: "drop", Name: "old_things"},
		{Kind: "rename", Name: "a → b"},
		{Kind: "migration", Name: "backfill_totals", New: true},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestSummarizeAPIFiles(t *testing.T) {
	files := []touchedFile{
		{Path: "routes/api.php", Status: "modified", Patch: "@@ -1,3 +1,3 @@\n-Route::get('/orders/old', [A::class, 'x']);\n+Route::post('/orders/{id}/refund', [A::class, 'y']);\n Route::get('/same', X::class);\n"},
		{Path: "app/Http/Resources/OrderResource.php", Status: "modified", Patch: "-            'total' => $this->total,\n+            'total' => $this->total_cents,\n+            'currency' => $this->currency,\n-            'legacy' => 1,\n"},
		{Path: "modules/Auth/Http/Requests/LoginRequest.php", Status: "added", Patch: "+            'email' => 'required',\n"},
		{Path: "app/Http/Controllers/OrderController.php", Status: "modified", Patch: "+        return 1;\n"},
		{Path: "app/Models/Order.php", Status: "modified", Patch: "+x\n"},
	}
	got := summarizeTouched(files)
	want := &touchSummary{API: []touchItem{
		{Kind: "routes", Name: "api", Add: []string{"POST /orders/{id}/refund"}, Del: []string{"GET /orders/old"}},
		{Kind: "resource", Name: "OrderResource", Add: []string{"currency"}, Del: []string{"legacy"}},
		{Kind: "request", Name: "LoginRequest", New: true, Add: []string{"email"}},
		{Kind: "controller", Name: "OrderController"},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestSummarizeTouchedNothing(t *testing.T) {
	if got := summarizeTouched([]touchedFile{{Path: "app/Models/Order.php"}}); got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestParseTouchedFiles(t *testing.T) {
	out := []byte(`[[{"filename":"routes/api.php","status":"modified","patch":"+a"},{"filename":"app/X.php","status":"modified"}],[{"filename":"database/migrations/m.php","status":"added","patch":"+b"}]]`)
	got, err := parseTouchedFiles(out, map[string]bool{"routes/api.php": true, "database/migrations/m.php": true})
	if err != nil {
		t.Fatal(err)
	}
	want := []touchedFile{
		{Path: "database/migrations/m.php", Status: "added", Patch: "+b"},
		{Path: "routes/api.php", Status: "modified", Patch: "+a"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
