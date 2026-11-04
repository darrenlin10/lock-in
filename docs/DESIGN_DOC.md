# DeskSheet / Lock-In — Revised Design Document

**Revision date:** November 4, 2026  
**Original design date:** November 3, 2026  
**Status:** Reviewed design; no implementation performed  
**Primary deliverable:** A useful countdown lock screen for the Handshake Google mission  
**Optional extension:** A native productivity and wallpaper studio app  
**Deadline recorded in the original:** November 23, 2026, 11:59 PM PT — **not independently verified** in the accessible mission brief.

## 1. How to read this revision

The original design notes, feature descriptions, and prompt are retained verbatim in Appendix A. They document the original vision; the revised decisions in Sections 2–8 take precedence where they differ. The original dated development phases have been removed and their work converted into sequential tasks in Section 8, including deferred features.

The source originally supplied as `DESIGN_DOC.md` was subsequently found as `Google_challenge_DESIGN_DOC.md` in Downloads with the same design content. The source file has not been edited. DeskSheet and Lock-In are retained as working names; choose one before presenting the project.

The numbered task list is a specification for future work, not a claim that those tasks have already been completed. Deadline-planning checkpoints remain part of the product concept; the removed milestones are the dated software-development schedule.

## 2. Challenge alignment and scope

### 2.1 Verified brief

The matching public mission is [Your Deadline, Your Design: Create a Countdown Lock Screen with Google](https://joinhandshake.com/learn/your-deadline-your-design-create-a-countdown-lock-screen-e748e649/). It describes Gemini-assisted deadline planning and lists backward planning, device-formatted lock-screen design, and reminder scheduling as learning outcomes. The deliverable is a lock screen for a phone or computer; the page estimates 15 minutes and lists a Google account, with a Google AI plan optional. It does not list a native app or API integration as a requirement.

**Design interpretation:** Deliver a useful planning artifact first. The original app is an optional extension. A decorative image alone would leave the planning and reminder outcomes unaddressed.

### 2.2 Requirements still to verify

The [signed-in mission step supplied by the user](https://app.joinhandshake.com/learn/your-deadline-your-design-create-a-countdown-lock-screen-e748e649/mission_step_cmvqrpa9a0aiw22ubfo7ebelc) could not be read during this review: web access failed, and browser access reached a security-verification page. The public overview does not establish:

- The exact submission deadline and timezone.
- Required files, links, captions, screenshots, or prompt history.
- Judging criteria, eligibility, prizes, or other challenge-specific terms.
- Whether the detailed steps require a particular Gemini workflow or additional tools.

Do not present the original November 23 deadline, suggested evidence package, or technical extension as verified competition requirements. Check the signed-in instructions before finalizing the submission. The recommendations below are project decisions unless explicitly attributed to the official brief.

### 2.3 Scope boundary

| Area | Challenge submission | Optional app MVP | Later extension |
|---|---|---|---|
| Planning | One real deadline and a checked backward plan | Local tasks plus one deadline target | Multiple plans and advanced prioritization |
| Visuals | One polished desk-and-paper lock screen | Three bundled styles; optional Gemini backgrounds | Full aesthetic catalog |
| Countdown | Clearly dated snapshot and exact target date | Snapshot wallpaper; compact native countdown widget if validated | Broader live integrations |
| Reminders | Schedule and verify reminders using an available tool | Local reminder flow if included in scope | Calendar-linked scheduling |
| Calendar | No API integration needed for proposed submission path | Optional read-only event import | Explicit task-to-event linking and two-way edits |
| Platforms | One actual phone or computer | One mobile platform and tested devices | Second mobile platform |
| AI access | Gemini workflow required by the brief | Useful without a key; BYOK customization optional | Managed service if justified |
| Wallpaper installation | Manual installation is the baseline | Platform-specific apply/export flow | Additional automation after device testing |

## 3. Product purpose and user experience

### 3.1 Core value

Help a person keep one important deadline and the next few actions visible. The professional desk scene is the visual identity. Accuracy, readability, and a realistic plan determine usefulness.

The first experience should be: choose a deadline → plan backward → select the next actions → create a readable lock screen → install it → schedule reminders → review progress.

### 3.2 Content rules

- Display one deadline title, its exact date, and a small set of upcoming actions. Start with at most three actions; increase only after readability testing on the target device.
- Choose visible actions explicitly or by a documented priority/due-date order. Do not silently replace a user's pinned item.
- Keep full task titles in the plan/app. If an item cannot fit at the minimum readable size, shorten its display label with user review or show an overflow count. Do not keep shrinking text.
- Include a generation/as-of date when displaying a numeric days-remaining value. Always retain the absolute target date.
- Completed tasks leave the next generated snapshot. The installed wallpaper may still show them until it is replaced.
- Wallpaper checkboxes are visual marks. Tapping a checkbox drawn into an image does not complete a task.
- Let users choose which details appear on the publicly visible lock screen. Use non-sensitive example content in a shared demo.

### 3.3 Countdown semantics

For date-only deadlines, calculate remaining calendar days in the selected timezone. Show “Due today” on the target date and “Overdue” after it. For timed deadlines, store the target instant and its display timezone, and state what happens when it is reached. Do not calculate calendar-day countdowns by dividing elapsed seconds by 86,400 across daylight-saving changes.

A wallpaper is a snapshot, not a running timer. A daily refresh can be a convenience, but its success must be checked separately from image generation. The baseline remains usable with an absolute deadline date even if automation is unavailable.

## 4. Revised architecture for the optional app

### 4.1 Local data is authoritative

The app's persisted task and deadline records are the source of truth for local work. Generated images are derived outputs, never the data store. Imported Calendar events remain a separate record type owned by Google Calendar.

| Record | Minimum information | Ownership and behavior |
|---|---|---|
| Local task | Stable ID, title, completion, priority, optional due date/time, updated time | App owns completion and edits |
| Deadline target | Title, date-only or timed target, timezone | Drives countdown calculations |
| Calendar event cache | Calendar ID, event/instance identity, title, start/end, source update value, last fetched time | Read-only in MVP; refresh from Google |
| Layout preset | Target pixel dimensions, content rectangle, text rules, chosen style | App controls composition |
| Wallpaper snapshot | Snapshot ID, generated time, target device, source-data version, image path | Immutable output; distinguish generated/exported/applied state |

Calendar events do not have a task-completion status: their standard statuses are confirmed, tentative, and cancelled. A unified view may display events and tasks together, but it must retain their different semantics. Marking a local task complete must not cancel a meeting. [Google Calendar event reference](https://developers.google.com/workspace/calendar/api/v3/reference/events).

### 4.2 Rendering: app-controlled paper and text

Use a single functional pipeline:

```text
Gemini-generated or bundled desk background
                +
App-rendered paper, texture, border, and shadow
                +
App-rendered deadline, task labels, and checkboxes
                ↓
Device-sized image → preview → export/apply

Local task/deadline store → separate compact native widget
```

This revises Mode B. Generate scenery without a paper sheet, then draw the paper at known coordinates. Otherwise, even blank AI-generated paper can vary in position, rotation, and size and make text placement unreliable.

The compositor owns output dimensions, paper bounds, padding, font size, line wrapping, maximum rows, contrast, and cropping. Prompt language guides aesthetics; it does not enforce geometry. Use the selected model's supported image configuration and crop/compose to the exact export dimensions locally. Pin and verify the model identifier, supported sizes, latency, and cost before adding API integration. [Gemini image-generation documentation](https://ai.google.dev/gemini-api/docs/image-generation).

Mode A is preserved in Appendix A as a deferred creative experiment. It is not the app's functional task renderer. For the one-off challenge artifact, a Gemini-generated complete image can be used if every date and label is checked and corrected; building this compositor is not a prerequisite for that submission.

### 4.3 AI and BYOK boundary

- Bundle three usable backgrounds so tasks, previews, and exports work without AI access.
- Call Gemini when the visual style changes, not when a task is checked off or a countdown changes.
- Send only aesthetic instructions in the app's default generation path; compose task/event text on-device.
- Store user-provided keys in secure platform storage. Provide key removal and never include keys in logs, screenshots, exports, or repository files.
- Validate connection/model access before generation. Handle invalid credentials, quota exhaustion, network failure, and unusable output without discarding the previous usable image.
- Describe charges as borne by the user's API project where applicable. Avoid promising that generation is free.

BYOK avoids shipping one shared developer secret. Secure storage does not eliminate all client-side exposure risks; Google's guidance warns against embedding developer API keys in client apps. [Gemini API-key guidance](https://ai.google.dev/gemini-api/docs/api-key).

### 4.4 Calendar integration

MVP integration, if included, requests only the scopes needed for read-only access to selected calendar events. Refresh on app open or explicit user action and show the last successful fetch time. Cached data remains available offline and is visibly stale where relevant. Handle revoked authorization without affecting local tasks. Scope selection and public-app verification requirements must be reviewed before release. [Calendar authorization guidance](https://developers.google.com/workspace/calendar/api/auth).

Two-way editing is deferred until there is an explicit design for task-event links, recurring instances, permissions, deletions, offline mutation queues, retries without duplicate creation, and concurrent edits. Incremental sync must persist tokens and recover through full resynchronization when a token becomes invalid. [Calendar synchronization guide](https://developers.google.com/workspace/calendar/api/guides/sync).

A backend-free polling design is possible, but it does not promise immediate remote updates while the app is inactive. Calendar push notifications require an HTTPS receiver, so adopting that path changes the backend scope. [Calendar push documentation](https://developers.google.com/workspace/calendar/api/guides/push).

## 5. Lock-screen behavior and device support

### 5.1 Freshness contract

| Trigger | App data/preview | Installed wallpaper | Widget, if included |
|---|---|---|---|
| Local task edited/completed | Persist and regenerate preview locally | Replace only after a successful supported apply/export workflow | Publish new shared data and request reload |
| Calendar changed elsewhere | Update after successful fetch | Regenerate, then apply separately | Update after fetch and reload request |
| Midnight/date rollover | Recalculate when app or supported background workflow runs | Existing pixels remain unchanged until replacement | Use timeline/date facilities supported by the platform |
| Network or AI failure | Local tasks and bundled/cached visuals keep working | Keep last installed image | Keep available local data |
| Automation disabled/fails | Explain how to export/apply manually | Do not claim the wallpaper is current | Independent widget behavior |

Track “generated,” “exported,” and “applied” separately. Where application cannot be confirmed, show “exported; installation not confirmed” instead of “synced.” Use a clear snapshot timestamp in the app and on time-sensitive image content.

### 5.2 Platform boundaries

**iOS:** Begin with image export and installation guidance. Treat Shortcuts automation as an optional setup flow requiring device testing, not a generic silent app-controlled refresh promise. Apple documents which automations can run automatically. [Shortcuts automation guide](https://support.apple.com/en-euro/guide/shortcuts/-apd602971e63/ios).

WidgetKit refresh is system-managed. A countdown can use dynamic date views without treating the whole widget as continuously executing. Start with one countdown or one next action and verify readability before adding a task list. [WidgetKit refresh](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date), [dynamic dates](https://developer.apple.com/documentation/widgetkit/displaying-dynamic-dates).

**Android:** Test the lock-screen-specific WallpaperManager path and its result on the supported devices. Keep export as a fallback. Lock-screen widget experience depends on device/OS implementation; Glance alone does not establish universal support. [WallpaperManager](https://developer.android.com/reference/android/app/WallpaperManager), [Android lock-screen widget FAQ](https://android-developers.googleblog.com/2025/03/widgets-on-lock-screen-faq.html).

**Framework:** Use the framework the team can ship and debug reliably after the target-device feasibility check. Cross-platform UI sharing does not remove extension, permission, signing, storage-sharing, and automation work. Expo app extensions, for example, require explicit build configuration. [Expo app extensions](https://docs.expo.dev/build-reference/app-extensions/).

### 5.3 Layout calibration

Use actual pixel dimensions and a saved content rectangle rather than relying only on labels such as Pro Max or 20:9. Provide a preview and controls to move/resize the paper and adjust top/bottom clearance. Device presets are starting points, not guarantees.

Check the installed result with the user's clock settings, typical notifications, and available widget layout. Clock customization can alter available space. [Apple lock-screen customization](https://support.apple.com/guide/iphone/create-a-custom-lock-screen-iph4d0e6c351/ios).

## 6. Updated prompt templates

These are proposed prompts for future use. The original full-image prompt remains unchanged in Appendix A.

### 6.1 Gemini planning prompt for the challenge

```text
Help me plan backward from this deadline:
- Goal: {{GOAL}}
- Deadline: {{DEADLINE_WITH_TIMEZONE}}
- Current date: {{CURRENT_DATE}}
- Available work time and constraints: {{CAPACITY_AND_CONSTRAINTS}}

Suggest a small, achievable sequence of actions with dates and a final review buffer.
Identify missing information and assumptions instead of inventing commitments.
Then propose three concise next-action labels for a countdown lock screen and
a reminder schedule I can review and set up. Do not claim reminders are scheduled.
Keep the full plan separate from the short display labels.
```

Review the proposed dates and workload before accepting them. Scheduling is a separate action that must be verified in the chosen reminder tool.

### 6.2 Gemini scenery prompt for the optional app

```text
Create a vertical, top-down flat-lay background for a professional desk wallpaper.
Desk material: {{DESK_MATERIAL}}
Lighting: {{LIGHTING_STYLE}}
Peripheral accessories: {{ACCESSORIES}}

Keep the central {{CONTENT_RECT_DESCRIPTION}} clear for a paper overlay that
the app will add later. Keep the top and bottom clearance regions visually quiet.
Do not draw paper, text, numbers, clocks, logos, checkboxes, or interface controls.
Keep accessories near the outer edges and avoid strong highlights in clear regions.
Use a camera view perpendicular to the desk surface with no perspective tilt.
```

Configure supported image dimensions through the API, then inspect/crop the result. Reject or regenerate backgrounds whose accessories compromise the paper or clock region. Do not rely on the prompt alone for acceptance.

## 7. Completion criteria

### 7.1 Challenge artifact

- A real deadline, timezone, and practical backward plan have been checked.
- The image is readable on the actual selected device; labels and countdown are correct as of the stated date.
- The lock screen is installed and reminders are actually scheduled and checked.
- The role of Gemini and any additional editing is described honestly.
- The required submission items match the signed-in mission instructions; the final deadline is verified there.

Keep the final image, a view of it installed, planning notes, and reminder evidence as a recommended preparation package. These are not asserted to be the challenge's exact required upload fields.

### 7.2 Optional app MVP

- Create/edit/complete a local task, restart the app, and verify persistence.
- A text-only edit changes the rendered content without another image-generation call.
- Long labels, no tasks, three tasks, and overflow have readable behavior.
- Date-only/timed deadlines, midnight, timezone changes, and expired targets have defined behavior.
- Invalid key, lost network, rejected permissions, and failed generation preserve usable local functionality.
- Actual export/application is checked on the supported device; UI never confuses export with confirmed installation.
- If included, Calendar import handles recurrence/deletions and stale data correctly, and widget refresh limitations are documented.

## 8. Sequential tasks

Complete the challenge sequence first. The optional app sequence begins only if the product extension is pursued. Within each sequence, finish the listed acceptance condition before moving to the next task. There are no dated development phases.

### 8.1 Challenge submission sequence

1. [ ] **Verify the signed-in brief.** Record the deadline, required tools, exact submission fields, and any judging/eligibility terms. Done when the unknowns in Section 2.2 are resolved from the mission or official rules.
2. [ ] **Choose one deadline and target device.** Record the goal, exact due date/time or date-only convention, timezone, and screen dimensions. Done when the content and device are unambiguous.
3. [ ] **Create and review the backward plan with Gemini.** Check workload, action order, dates, and a review buffer. Done when the plan is realistic and the next three display actions are selected.
4. [ ] **Create the desk-and-paper lock-screen design.** Use Gemini in the required workflow, then correct text/layout as needed. Done when the image contains the verified deadline and readable next actions.
5. [ ] **Install and inspect the image.** Check clock overlap, cropping, notification interference, and text size on the real device. Done when the installed image is readable and correctly dated.
6. [ ] **Schedule and verify reminders.** Use the accepted plan and an available reminder/calendar tool. Done when the entries exist at the intended times; a generated suggestion alone does not count.
7. [ ] **Prepare the requested submission evidence.** Follow the verified upload fields and explain the goal, Gemini's contribution, refinements, and practical use. Done when all required materials are ready and accurate.
8. [ ] **Review and submit through Handshake.** Check the verified deadline and requirements before submission. Done when Handshake confirms submission. This document does not authorize or perform submission.

### 8.2 Optional app MVP sequence

9. [ ] **Choose one platform and prove the lock-screen loop.** Use a simple sample image to test export/apply, device layout, and a compact widget if required. Done when platform limits and manual fallbacks are recorded.
10. [ ] **Choose the framework and scaffold.** Select React Native/Expo or Flutter based on the proven integration path and team experience. Done when a device build and required native configuration work.
11. [ ] **Build local tasks and the deadline model.** Implement persistence, separate date-only/timed targets, completion, priority, and display selection. Done when edits survive restart and date behavior is verified.
12. [ ] **Build deterministic composition and bundled presets.** Draw paper/text locally over three backgrounds and add calibration, wrapping, and overflow. Done when correct images can be exported offline without a key.
13. [ ] **Add the limited aesthetic customizer.** Expose tested desk/paper/lighting options and preview controls. Done when each supported selection produces readable output on the chosen device set.
14. [ ] **Add optional Gemini BYOK scenery generation.** Pin the model, verify connection, use secure key storage, add key removal, cache results, and handle failures. Done when a style can be generated and task edits require no further AI call.
15. [ ] **Complete wallpaper state and application handling.** Distinguish generation/export/application, implement supported platform behavior, and document the optional automation setup. Done when both success and failure states are truthful on-device.
16. [ ] **Add one compact native widget if retained.** Share local data, use native countdown facilities, and request refreshes appropriately. Done when the widget remains readable and its observed update behavior matches the documented contract.
17. [ ] **Add read-only Calendar import if retained.** Configure OAuth, select minimal scopes, separate events from tasks, cache results, and handle revocation/staleness. Done when importing never changes remote events and recurrence/deletions are handled.
18. [ ] **Validate the MVP and prepare its demo.** Exercise Section 7.2, test the supported screen sizes, and capture honest screenshots/video of implemented behavior. Done when the advertised feature set matches the working build.

### 8.3 Deferred extension sequence

19. [ ] **Specify and implement explicit task-to-event linking.** Define scheduling versus completion and user-owned edits before adding Calendar writes. Done when a task can link to an event without ambiguous deletion/completion behavior.
20. [ ] **Implement resilient two-way Calendar synchronization.** Add conflict rules, recurring-instance support, deletion handling, offline queues, idempotent retries, and token recovery. Done when concurrent/offline changes reconcile predictably.
21. [ ] **Expand platform support and automation.** Add the second mobile platform with its own support matrix and tested apply/widget paths. Done when each advertised device/OS combination has verified behavior.
22. [ ] **Expand the aesthetic catalog.** Add remaining desk, paper, accessory, lighting, and typography options from the original notes. Done when each passes the same composition checks.
23. [ ] **Evaluate full-AI Mode A as an optional art feature.** Clearly label it as a generated snapshot and validate all displayed text before use. Done when it cannot silently replace the authoritative task data or functional renderer.

## Appendix A. Original notes retained for reference

The following original Sections 1–4 are preserved verbatim, including their terminology, comments, and prompt. They are historical context, not unresolved overrides of the revised decisions above. The original dated Section 5 is intentionally omitted; its work is retained in the sequential task list.

## 1\. Project Overview & Vision

**Lock-In** is a native mobile productivity and lock screen studio app (combining Native Lock Screen Widgets with a Bring-Your-Own-Key Gemini Wallpaper Generator). It turns a user's upcoming Google Calendar events and custom to-do items into a high-resolution lock screen wallpaper set in a **professional workspace**—a crisp sheet of paper resting on a curated desk, formatted to fit cleanly below the phone's lock screen clock and above bottom system shortcuts.

## 2\. Hybrid Architecture (Native App \+ BYOK Gemini Studio)

- **Client Framework:** Cross-platform native mobile app (**React Native / Expo** or **Flutter**) supporting iOS and Android screen sizes, safe-zone presets, and native Lock Screen Widgets (`WidgetKit` on iOS / `Glance AppWidget` on Android).  
- **Bring Your Own Key (BYOK) Gemini API Integration:**  
  - Users enter their own Gemini API key in the app's settings, stored securely on-device (`Expo SecureStore` / iOS Keychain / Android Keystore).  
  - Direct client-side calls to the Gemini API (`@google/genai` / REST API) for multimodal lock screen wallpaper generation—zero backend proxy costs required.  
- **System Prompt Configuration (`WALLPAPER_SYSTEM_PROMPT.md`):**  
  - The app ships with a structured system instructions file that constrains and guides Gemini image generation so every generated desk wallpaper:  
1. Respects the user's device aspect ratio and top clock / bottom button safe zones.  
2. Positions a clean, high-contrast sheet of paper in the center-lower canvas area.  
3. Applies the user's selected aesthetic parameters (desk material, lighting mood, paper texture, accessories, and typography style).  
- **Two-Layer Rendering Pipeline (Full AI Render \+ Fast Crisp Text Mode):**  
  - **Mode A (Full Multimodal AI Render):** Injects the user's live task list and countdown directly into the guided Gemini image prompt to render the desk, paper, and printed checklist in one pass.  
  - **Mode B (AI Desk \+ Crisp Native Text Overlay):** Uses Gemini to generate the customized desk and blank stationery sheet, then dynamically composites razor-sharp typography and checkboxes from Google Calendar \+ local tasks whenever a task is added, edited, or checked off (saving API quota on quick task edits).

## 3\. Core Functional Modules

1. **Two-Way Google Calendar \+ Local Task Engine:**  
   - OAuth 2.0 sign-in with `Google Calendar API` read/write scopes.  
   - Unified task list showing synced Calendar events alongside standalone local tasks.  
   - Full CRUD support: add, modify, check off, or delete tasks with a toggle for *"Sync to Google Calendar"* vs. *"Keep on Lock Screen Only"*.  
2. **Aesthetic & Screen-Size Customizer:**  
   - **Desk Presets:** Warm Walnut, Matte Black Executive, White Carrara Marble, Brushed Oak.  
   - **Paper Styles:** Crisp White Cardstock, Warm Cream Stationery, Lined Legal Pad, Dot Grid.  
   - **Accessories & Lighting:** Fountain pen, espresso cup, brass lamp, morning daylight vs. warm evening desk lamp.  
   - **Device Safe-Zone Presets:** Dynamic viewport calibration for iPhone (Standard, Pro, Pro Max) and Android (16:9, 19.5:9, 20:9) so the lock screen clock never overlaps the paper header.  
3. **Lock Screen Sync & Native Widgets:**  
   - **Wallpaper Export & Auto-Apply:** One-tap save to Photos, automatic Android wallpaper setter (`WallpaperManager`), and iOS Shortcut hook to auto-refresh the lock screen wallpaper.  
   - **Companion Lock Screen Widget:** Native iOS/Android lock screen widget displaying the top countdown and next 2–3 priority tasks for instant glanceability.

## 4\. Bundled System Prompt Template (`WALLPAPER_SYSTEM_PROMPT.md`)

```
You are the DeskSheet Lock Screen Visual Engine. Your job is to generate a vertical smartphone lock screen wallpaper depicting a top-down flat-lay of a professional desk with a clean sheet of paper centered in the middle-to-lower safe zone.

HARD LAYOUT CONSTRAINTS:
1. Aspect Ratio & Safe Zones: Target {{DEVICE_ASPECT_RATIO}}. Leave the top {{TOP_CLOCK_OFFSET_PERCENT}}% of the canvas as uncluttered desk surface (no bright objects or text) so the OS lock screen clock remains legible. Leave the bottom {{BOTTOM_SAFE_PERCENT}}% free of text for OS lock screen shortcuts.
2. Paper Placement: Place a flat, rectangular sheet of {{PAPER_STYLE}} paper occupying the central safe zone, perfectly aligned with the camera plane.
3. Aesthetic & Lighting: Desk surface is {{DESK_MATERIAL}} with {{LIGHTING_STYLE}} lighting. Subtle peripheral desk accessories ({{ACCESSORIES}}) must remain strictly outside the paper boundaries.
4. Task List Typography (when rendering text directly): Render the following countdown header and task items neatly on the sheet of paper in crisp, legible {{FONT_STYLE}} ink:
   - Header: {{COUNTDOWN_HEADER}}
   - Tasks:
{{TASK_LIST_FORMATTED}}
```
