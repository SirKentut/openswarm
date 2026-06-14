// Neutralizes a Chromium browser-process crash: releasing the mouse OUTSIDE the
// window during a drag (trivial with a second display) makes RootView::UpdateCursor
// deref a null view (GetEventHandlerForPoint returns null for an off-widget point,
// root_view.cc:852) and SIGSEGVs the whole app. We can't catch it in JS, it's
// upstream of our renderer, so we sit on a supported AppKit local event monitor and
// snap any off-window mouse-UP to the window edge before Chromium hit-tests it; the
// lookup then always finds a view, so the null deref is unreachable. macOS-only.
//
// Fail-open in both directions: anything unexpected falls through to the original
// event, and we only touch releases that land fully outside the window, so the
// worst case is "behaves exactly like today".

#include <node_api.h>
#import <Cocoa/Cocoa.h>
#include "clamp_decision.h"

static id gMonitor = nil;

static NSEvent *ClampOffWindowRelease(NSEvent *event) {
  @try {
    NSEventType t = [event type];
    if (t != NSEventTypeLeftMouseUp && t != NSEventTypeRightMouseUp &&
        t != NSEventTypeOtherMouseUp) {
      return event;
    }
    NSWindow *win = [event window];
    NSView *content = [win contentView];
    if (!content) return event;
    NSPoint p = [event locationInWindow];
    NSSize ws = [win frame].size;
    NSRect cb = [content frame];
    // all the misfire-prone arithmetic lives in clamp_decision() so the property
    // test exercises the exact code that ships
    ClampDecision d = clamp_decision(p.x, p.y, ws.width, ws.height,
                                     cb.origin.x, cb.origin.y,
                                     cb.size.width, cb.size.height);
    if (!d.clamp) return event;
    NSEvent *clamped =
        [NSEvent mouseEventWithType:t
                           location:NSMakePoint(d.x, d.y)
                      modifierFlags:[event modifierFlags]
                          timestamp:[event timestamp]
                       windowNumber:[event windowNumber]
                            context:nil
                        eventNumber:[event eventNumber]
                         clickCount:[event clickCount]
                           pressure:[event pressure]];
    return clamped ? clamped : event;
  } @catch (...) {
    return event;
  }
}

static napi_value Install(napi_env env, napi_callback_info info) {
  bool ok = false;
  @autoreleasepool {
    if (gMonitor == nil) {
      NSEventMask mask = NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp |
                         NSEventMaskOtherMouseUp;
      gMonitor = [[NSEvent addLocalMonitorForEventsMatchingMask:mask
                            handler:^NSEvent *(NSEvent *e) {
                              return ClampOffWindowRelease(e);
                            }] retain];
      ok = (gMonitor != nil);
    } else {
      ok = true;
    }
  }
  napi_value result;
  napi_get_boolean(env, ok, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "install", NAPI_AUTO_LENGTH, Install, NULL, &fn);
  napi_set_named_property(env, exports, "install", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
