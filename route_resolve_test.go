package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"slash/modules/callresolve"
)

func TestRouteActionsIn(t *testing.T) {
	scan := `
    Route::post('/memberships/huddle/sso', [HuddleController::class, 'sso'])->withoutMiddleware('tenant_middleware');
    Route::post('/memberships/huddle/disconnect', [HuddleController::class, 'disconnect'])->withoutMiddleware('tenant_middleware');
    Route::get('/old', 'Legacy\OldController@index');
    Route::apiResource('/settings', SettingController::class)->only(['index', 'destroy']);
    Route::resource('/pages', PageController::class)->except(['create', 'edit']);
`
	var got []string
	for _, ra := range routeActionsIn(scan) {
		got = append(got, shortName(ra.Class)+"@"+ra.Method)
	}
	want := []string{
		"HuddleController@sso", "HuddleController@disconnect",
		"OldController@index",
		"SettingController@index", "SettingController@destroy",
		"PageController@index", "PageController@store", "PageController@show", "PageController@update", "PageController@destroy",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("routeActionsIn:\n got %v\nwant %v", got, want)
	}
}

func TestRouteMiddlewaresIn(t *testing.T) {
	scan := `Route::middleware(['2fa', 'auth:api', 'throttle:300|rate_limit,1'])->group(static function (): void {
    Route::post('/x', [A::class, 'b'])->withoutMiddleware('tenant_middleware')->middleware(RestrictScope::class);
    Route::group(['middleware' => ['App\Http\Middleware\Foo', 'bar']], fn () => null);
`
	got := routeMiddlewaresIn(scan)
	want := []routeMiddlewareRef{
		{Alias: "2fa"}, {Alias: "auth"}, {Alias: "throttle"},
		{Alias: "tenant_middleware"}, {Class: "RestrictScope"},
		{Class: "Foo"}, {Alias: "bar"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("routeMiddlewaresIn:\n got %+v\nwant %+v", got, want)
	}
}

func TestParseMiddlewareAliases(t *testing.T) {
	src := `<?php
final class Kernel extends HttpKernel {
    protected $middlewareGroups = [
        'api' => [ TenantMiddleware::class ],
    ];
    protected $middlewareAliases = [
        '2fa'               => Check2FA::class,
        'tenant_middleware' => \App\Http\Middleware\TenantMiddleware::class,
    ];
}`
	got := parseMiddlewareAliases(src)
	want := map[string]string{"2fa": "Check2FA", "tenant_middleware": "TenantMiddleware"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseMiddlewareAliases = %v, want %v", got, want)
	}
}

// TestResolveCallsRouteFile is the PR 13997 shape: two routes on one
// controller must each link their OWN method (not the class + "first
// method"), a resource route links its REST methods, and a middleware alias
// only links when the PR changed that middleware class.
func TestResolveCallsRouteFile(t *testing.T) {
	dataDir := t.TempDir()
	pr := 41
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"modules/Memberships/Internal/Http/Routes/api.php": `<?php
use Modules\Memberships\Internal\Http\Controllers\HuddleController;
use Modules\Memberships\Internal\Http\Controllers\SettingController;
Route::middleware(['2fa', 'auth:api'])->group(static function (): void {
    Route::post('/memberships/huddle/sso', [HuddleController::class, 'sso'])->withoutMiddleware('tenant_middleware');
    Route::post('/memberships/huddle/disconnect', [HuddleController::class, 'disconnect'])->withoutMiddleware('scope_middleware');
    Route::apiResource('/memberships/settings', SettingController::class);
});
`,
		"modules/Memberships/Internal/Http/Controllers/HuddleController.php": `<?php
namespace Modules\Memberships\Internal\Http\Controllers;
final class HuddleController {
    public function levels(): void {}
    public function sso(): void {}
    public function disconnect(): void {}
}
`,
		// Same short name in another module: the use import must win.
		"modules/Other/Http/Controllers/HuddleController.php": `<?php
namespace Modules\Other\Http\Controllers;
final class HuddleController {
    public function disconnect(): void {}
}
`,
		"modules/Memberships/Internal/Http/Controllers/SettingController.php": `<?php
namespace Modules\Memberships\Internal\Http\Controllers;
final class SettingController {
    public function index(): void {}
    public function destroy(): void {}
    public function helper(): void {}
}
`,
		"app/Http/Kernel.php": `<?php
final class Kernel {
    protected $middlewareAliases = [
        '2fa'               => Check2FA::class,
        'tenant_middleware' => TenantMiddleware::class,
        'scope_middleware'  => ScopeMiddleware::class,
    ];
}
`,
		"app/Http/Middleware/TenantMiddleware.php": `<?php
final class TenantMiddleware {
    public function handle($request, $next) { return $next($request); }
}
`,
		"app/Http/Middleware/ScopeMiddleware.php": `<?php
final class ScopeMiddleware {
    public function handle($request, $next) { return $next($request); }
}
`,
		"app/Http/Middleware/Check2FA.php": `<?php
final class Check2FA {
    public function handle($request, $next) { return $next($request); }
}
`,
	}
	for rel, body := range files {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	routeFile := "modules/Memberships/Internal/Http/Routes/api.php"
	if got := categoryFor(routeFile); got != "ROUTE" {
		t.Fatalf("categoryFor(%s) = %q, want ROUTE", routeFile, got)
	}
	caller := Block{PR: pr, File: routeFile, Name: "api.php", Side: SideNew, Status: StatusModified, Category: "ROUTE"}
	// Only ScopeMiddleware is changed by this PR.
	changedMw := Block{PR: pr, File: "app/Http/Middleware/ScopeMiddleware.php", Class: "ScopeMiddleware", Name: "handle", Side: SideNew, Status: StatusAdded}
	entries := resolveCalls(dataDir, pr, []Block{caller, changedMw})

	for key, wantMethod := range map[string]string{
		"route_action:HuddleController@sso":        "sso",
		"route_action:HuddleController@disconnect": "disconnect",
		"route_action:SettingController@index":     "index",
		"route_action:SettingController@destroy":   "destroy",
	} {
		e, ok := findEntry(entries, key)
		if !ok {
			t.Errorf("no entry for %s", key)
			continue
		}
		if e.Kind != callresolve.KindRouteAction || e.ChildMethod != wantMethod {
			t.Errorf("%s: kind=%q method=%q, want %q/%s", key, e.Kind, e.ChildMethod, callresolve.KindRouteAction, wantMethod)
		}
	}
	if e, _ := findEntry(entries, "route_action:HuddleController@disconnect"); e.ChildFile != "modules/Memberships/Internal/Http/Controllers/HuddleController.php" {
		t.Errorf("disconnect resolved to %s, want the imported Memberships controller", e.ChildFile)
	}
	if _, ok := findEntry(entries, "route_action:SettingController@show"); ok {
		t.Error("SettingController has no show(), want no entry")
	}

	mw, ok := findEntry(entries, "middleware:scope_middleware")
	if !ok || mw.Kind != callresolve.KindRouteMiddleware || mw.ChildClass != "ScopeMiddleware" || mw.ChildMethod != "handle" {
		t.Errorf("middleware:scope_middleware = %+v (found=%v), want ScopeMiddleware::handle", mw, ok)
	}
	for _, key := range []string{"middleware:tenant_middleware", "middleware:2fa", "middleware:auth"} {
		if _, ok := findEntry(entries, key); ok {
			t.Errorf("%s: unchanged middleware, want no entry", key)
		}
	}
	for _, key := range []string{
		"HuddleController", "class_method:HuddleController", "class_ctor:HuddleController",
		"SettingController", "class_method:SettingController",
		"post", "group", "middleware", "withoutMiddleware", "apiResource",
	} {
		if _, ok := findEntry(entries, key); ok {
			t.Errorf("unexpected entry %q", key)
		}
	}
}
