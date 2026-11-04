// Prompt templates (design doc §6). Templates are kept verbatim from the
// design document; only the {{PLACEHOLDERS}} are filled in.
//
// Pure module.

export const PLANNING_TEMPLATE = `Help me plan backward from this deadline:
- Goal: {{GOAL}}
- Deadline: {{DEADLINE_WITH_TIMEZONE}}
- Current date: {{CURRENT_DATE}}
- Available work time and constraints: {{CAPACITY_AND_CONSTRAINTS}}

Suggest a small, achievable sequence of actions with dates and a final review buffer.
Identify missing information and assumptions instead of inventing commitments.
Then propose three concise next-action labels for a countdown lock screen and
a reminder schedule I can review and set up. Do not claim reminders are scheduled.
Keep the full plan separate from the short display labels.`;

// One extra line (outside the verbatim template) asks for an import-friendly
// list so the plan can be pasted back into Lock-In. It is optional in the UI.
export const PLANNING_FORMAT_HINT =
  'Format the action list as one line per action: YYYY-MM-DD — action.';

export const SCENERY_TEMPLATE = `Create a vertical, top-down flat-lay background for a professional desk wallpaper.
Desk material: {{DESK_MATERIAL}}
Lighting: {{LIGHTING_STYLE}}
Peripheral accessories: {{ACCESSORIES}}

Keep the central {{CONTENT_RECT_DESCRIPTION}} clear for a paper overlay that
the app will add later. Keep the top and bottom clearance regions visually quiet.
Do not draw paper, text, numbers, clocks, logos, checkboxes, or interface controls.
Keep accessories near the outer edges and avoid strong highlights in clear regions.
Use a camera view perpendicular to the desk surface with no perspective tilt.`;

export function fillTemplate(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    const v = values[key];
    return v === undefined || v === null || String(v).trim() === '' ? `[${key.toLowerCase().replace(/_/g, ' ')}]` : String(v);
  });
}

export function planningPrompt({ goal, deadlineText, currentDate, capacity, includeFormatHint = true }) {
  const body = fillTemplate(PLANNING_TEMPLATE, {
    GOAL: goal,
    DEADLINE_WITH_TIMEZONE: deadlineText,
    CURRENT_DATE: currentDate,
    CAPACITY_AND_CONSTRAINTS: capacity,
  });
  return includeFormatHint ? `${body}\n${PLANNING_FORMAT_HINT}` : body;
}

export function sceneryPrompt({ desk, lighting, accessories, rectDescription, orientation = 'vertical' }) {
  let text = fillTemplate(SCENERY_TEMPLATE, {
    DESK_MATERIAL: desk,
    LIGHTING_STYLE: lighting,
    ACCESSORIES: accessories && accessories.length ? accessories : 'none',
    CONTENT_RECT_DESCRIPTION: rectDescription,
  });
  // The template says "vertical"; computer lock screens are landscape.
  if (orientation === 'horizontal') text = text.replace('Create a vertical,', 'Create a horizontal,');
  return text;
}
