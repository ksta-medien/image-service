/**
 * SVG fallback image returned when a source image is not found in GCS.
 * Displayed as a 1280×1024 placeholder with a "not available" message.
 */
export const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" x="0px" y="0px" viewBox="0 0 1280 1024" style="enable-background:new 0 0 1280 1024;">
<style type="text/css">
	.st0{fill:#F9F9F9;}
	.st1{fill:#E6E6E6;}
	.st2{fill:none;}
	.st3{fill:#B3B3B3;}
	.st4{font-family:'ArialMT';}
	.st5{font-size:68px;}
</style>
<g id="Ebene_2">
	<rect class="st0" width="1280" height="1024"/>
</g>
<g id="Ebene_1">
	<g>
		<path class="st1" d="M479,391v267h377V391H479z M845,402v162.7l-60.4-76.9L724,560.5L623.5,463L490,588.7V402H845z M490,647v-43.2&#10;   l133.4-125.7l101.5,98.5l59.4-71.3l60.6,77.3V647H490z"/>
		<path class="st1" d="M714.5,490c17.9,0,32.5-14.6,32.5-32.5S732.4,425,714.5,425S682,439.6,682,457.5S696.6,490,714.5,490z&#10;    M714.5,436c11.9,0,21.5,9.6,21.5,21.5s-9.6,21.5-21.5,21.5s-21.5-9.6-21.5-21.5S702.6,436,714.5,436z"/>
	</g>
	<rect y="505" class="st2" width="1280" height="89.6"/>
	<text transform="matrix(1 0 0 1 261.5737 556.1191)" class="st3 st4 st5">Bild nicht mehr verf&#xFC;gbar</text>
</g>
</svg>`;

export const FALLBACK_SVG_BUFFER = Buffer.from(FALLBACK_SVG, 'utf-8');
export const FALLBACK_CONTENT_TYPE = 'image/svg+xml';
