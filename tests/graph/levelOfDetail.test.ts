import assert from 'node:assert/strict';
import test from 'node:test';
import {
	fadeThresholdToLevelOfDetail,
	DEFAULT_FADE_THRESHOLD,
	FADE_THRESHOLD_MIN,
	FADE_THRESHOLD_MAX,
} from '../../src/graph/levelOfDetail';

test('the ladder order (edge labels, then node labels, then dots) holds at every slider value', () => {
	for (let value = FADE_THRESHOLD_MIN; value <= FADE_THRESHOLD_MAX; value += 5) {
		const lod = fadeThresholdToLevelOfDetail(value);
		assert.ok(
			lod.edgeLabelMinScale > lod.labelMinScale,
			`edge label threshold should exceed node label threshold at slider ${value}`,
		);
		assert.ok(
			lod.labelMinScale > lod.dotMinScale,
			`node label threshold should exceed dot threshold at slider ${value}`,
		);
	}
});

test('the default slider value reproduces the ladder as it was before the slider existed', () => {
	const lod = fadeThresholdToLevelOfDetail(DEFAULT_FADE_THRESHOLD);
	assert.equal(lod.edgeLabelMinScale, 0.85);
	assert.equal(lod.labelMinScale, 0.5);
	assert.equal(lod.dotMinScale, 0.28);
});

test('a lower slider value shrinks every threshold, fading text out sooner', () => {
	const low = fadeThresholdToLevelOfDetail(FADE_THRESHOLD_MIN);
	const high = fadeThresholdToLevelOfDetail(FADE_THRESHOLD_MAX);
	assert.ok(low.edgeLabelMinScale < high.edgeLabelMinScale);
	assert.ok(low.labelMinScale < high.labelMinScale);
	assert.ok(low.dotMinScale < high.dotMinScale);
});

test('a slider value outside 0-100 clamps rather than producing an out-of-order or negative ladder', () => {
	const belowRange = fadeThresholdToLevelOfDetail(-50);
	const aboveRange = fadeThresholdToLevelOfDetail(500);
	assert.deepEqual(belowRange, fadeThresholdToLevelOfDetail(FADE_THRESHOLD_MIN));
	assert.deepEqual(aboveRange, fadeThresholdToLevelOfDetail(FADE_THRESHOLD_MAX));
});
