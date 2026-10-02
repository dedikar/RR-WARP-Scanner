'use strict';

// Page CSS, injected once per browser session.

var pageCssInjected = false;

function injectPageCss() {
	if (pageCssInjected) return;
	pageCssInjected = true;
	var css = [
		// Panels sit one theme step above the page background and carry a frame.
		'html .cbi-section.rrws-panel, html .rrws-panel {',
		'  border: 1px solid var(--border-color-medium, rgba(128,128,128,.35));',
		'  border-radius: 6px;',
		'  padding: 12px 14px;',
		'  margin: 14px 0;',
		'  background: var(--background-color-medium, transparent);',
		'}',
		// On a light background the same token resolves the other way, so no
		// separate light-theme frame is needed.
		'.rrws-panel > h3:first-child {',
		'  margin-top: 0;',
		'  padding-bottom: 6px;',
		'  border-bottom: 1px solid var(--border-color-low, #e4e4e4);',
		'}',
		// The log pane and the checkbox lists sit inside a panel and need the
		// same treatment as the panel border, not the old fixed colours.
		'.rrws-panel pre {',
		'  background: var(--background-color-high, #111);',
		'  border: 1px solid var(--border-color-low, #e4e4e4);',
		'}',
		'.rrws-checklist {',
		'  border: 1px solid var(--border-color-medium, rgba(128,128,128,.5));',
		'  border-radius: 4px;',
		'}',
		// A clickable disclosure needs to look clickable: the log summary was
		// plain text and read as an empty area.
		'.rrws-disclosure > summary {',
		'  cursor: pointer;',
		'  padding: 6px 14px;',
		'  font-weight: 600;',
		'  border: 1px solid var(--border-color-medium, rgba(128,128,128,.5));',
		'  border-radius: 6px;',
		'  background: var(--background-color-low, transparent);',
		'  list-style: none;',
		// inline-flex, not flex: a block-level summary stretches to the full
		// width of the panel, so the button looked like a bar rather than a
		// button. inline-flex sizes it to its own label and triangle.
		'  display: inline-flex;',
		'  align-items: center;',
		'  gap: 8px;',
		'  user-select: none;',
		'}',
		'.rrws-disclosure > summary::-webkit-details-marker { display: none; }',
		// Triangle drawn from a border so it does not depend on a font glyph
		// being present on the router's browser.
		'.rrws-disclosure > summary::before {',
		'  content: "";',
		'  width: 0; height: 0;',
		'  border-left: 6px solid currentColor;',
		'  border-top: 5px solid transparent;',
		'  border-bottom: 5px solid transparent;',
		'  transition: transform .15s;',
		'}',
		'.rrws-disclosure[open] > summary::before { transform: rotate(90deg); }',
		'.rrws-disclosure[open] > summary { margin-bottom: 8px; }',
		'.rrws-disclosure[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }',
		// Result cards.
		'.rrws-card {',
		'  border-left: 4px solid var(--border-color-high, #444);',
		'  border-top: 1px solid var(--border-color-medium, rgba(128,128,128,.35));',
		'  border-right: 1px solid var(--border-color-medium, rgba(128,128,128,.35));',
		'  border-bottom: 1px solid var(--border-color-medium, rgba(128,128,128,.35));',
		'  border-radius: 4px;',
		'  padding: 8px 10px;',
		'  margin: 6px 0;',
		'  background: var(--background-color-low, rgba(255,255,255,.06));',
		'}',
		'.rrws-card-best { border-left-color: #16a34a; }',
		'.rrws-card-torn { border-left-color: #b91c1c; opacity: .65; }',
		// The metadata line follows the theme so it stays legible on whatever
		'.rrws-card-meta { font-size: 13px; margin-top: 4px; color: var(--text-color-medium, #666); }',
		// The actions sit on the same line as the endpoint, pinned to the right edge
		// of the card. `flex: 0 0 auto` keeps them at their natural width so the
		// text column is the part that shrinks on a narrow screen.
		'.rrws-card-actions {',
		'  display: flex;',
		'  align-items: center;',
		'  gap: 6px;',
		'  flex: 0 0 auto;',
		'  margin: 0;',
		'}',
		// On a phone the one-row layout has no room: the text column shrinks until
		// every label wraps onto its own line, which is what the mobile screenshot
		// showed. Below this width the card stacks instead - data on top, actions
		// underneath - and the actions get their own full-width row.
		'@media (max-width: 700px) {',
		'  .rrws-card { flex-direction: column; align-items: stretch; }',
		'  .rrws-card-actions { justify-content: flex-start; margin-top: 8px; }',
		'  .rrws-card-actions > .btn { flex: 1 1 auto; }',
		// The endpoint line and the node summary both wrap on a phone; without this
		// the badges and node codes pile up with no separation.
		'  .rrws-card-meta { line-height: 1.6; }',
		// The label column in the settings blocks shrinks to a share of the row
		// instead of a fixed 230px, so the input keeps a usable width.
		'  .rrws-field-label { width: 40% !important; }',
		'}',
		'.rrws-field-label {',
		'  display: inline-block;',
		'  width: 230px;',
		'  color: var(--text-color-medium, #bbb);',
		'  vertical-align: top;',
		'}',
		// Sort keys, sitting between the summary and the cards.
		'.rrws-sortbar {',
		'  display: flex;',
		'  align-items: center;',
		'  gap: 6px;',
		'  flex-wrap: wrap;',
		'  margin: 4px 0 10px 0;',
		'}',
		'.rrws-sortbar-label {',
		'  font-size: 12px;',
		'  color: var(--text-color-medium, #888);',
		'  margin-right: 2px;',
		'}',
	].join('\n');

	var el = document.createElement('style');
	el.type = 'text/css';
	el.appendChild(document.createTextNode(css));
	document.head.appendChild(el);
}

return {
	injectPageCss: injectPageCss
};
