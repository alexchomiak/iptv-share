import test from "node:test";
import assert from "node:assert/strict";
import { liveSummaryLooksPartial } from "../src/server/sportsUpdateQuality.js";

test("holds a patch that temporarily removes all established leaders", () => {
  assert.equal(liveSummaryLooksPartial(
    { state: "in", leaders: [{ team: { id: "a" } }, { team: { id: "b" } }] },
    { state: "in", leaders: [] },
  ), true);
});

test("allows leaders to be empty before the game has established them", () => {
  assert.equal(liveSummaryLooksPartial(
    { state: "pre", leaders: [] },
    { state: "in", leaders: [] },
  ), false);
});

test("holds a current-quarter-only scoring patch that drops earlier periods", () => {
  assert.equal(liveSummaryLooksPartial(
    { state: "in", period: 2, scoringSummary: [{ id: "q1", period: { number: 1 } }, { id: "q2", period: { number: 2 } }] },
    { state: "in", period: 3, scoringSummary: [{ id: "q3", period: { number: 3 } }] },
  ), true);
});

test("allows an individual scoring correction instead of accumulating it", () => {
  assert.equal(liveSummaryLooksPartial(
    { state: "in", period: 3, scoringSummary: [{ id: "q1", period: { number: 1 } }, { id: "reversed", period: { number: 3 } }] },
    { state: "in", period: 3, scoringSummary: [{ id: "q1", period: { number: 1 } }] },
  ), false);
});

test("allows a full checkpoint-style summary with earlier and current periods", () => {
  assert.equal(liveSummaryLooksPartial(
    { state: "in", period: 2, scoringSummary: [{ id: "q1", period: { number: 1 } }] },
    { state: "in", period: 3, scoringSummary: [{ id: "q1", period: { number: 1 } }, { id: "q3", period: { number: 3 } }] },
  ), false);
});
