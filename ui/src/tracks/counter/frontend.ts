// Copyright (C) 2018 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as m from 'mithril';

import {searchSegment} from '../../base/binary_search';
import {assertTrue} from '../../base/logging';
import {Actions} from '../../common/actions';
import {toNs} from '../../common/time';
import {checkerboardExcept} from '../../frontend/checkerboard';
import {globals} from '../../frontend/globals';
import {NewTrackArgs, Track} from '../../frontend/track';
import {TrackButton, TrackButtonAttrs} from '../../frontend/track_panel';
import {trackRegistry} from '../../frontend/track_registry';

import {
  Config,
  COUNTER_TRACK_KIND,
  CounterScaleOptions,
  Data,
} from './common';

// 0.5 Makes the horizontal lines sharp.
const MARGIN_TOP = 3.5;
const RECT_HEIGHT = 24.5;

interface CounterScaleAttribute {
  follower: CounterScaleOptions;
  tooltip: string;
  icon: string;
}

function scaleTooltip(scale?: CounterScaleOptions): string {
  const description: CounterScaleAttribute = getCounterScaleAttribute(scale);
  const source: string = description.tooltip;
  const destination: string =
      getCounterScaleAttribute(description.follower).tooltip;
  return `Toggle scale from ${source} to ${destination}`;
}

function scaleIcon(scale?: CounterScaleOptions): string {
  return getCounterScaleAttribute(scale).icon;
}

function nextScale(scale?: CounterScaleOptions): CounterScaleOptions {
  return getCounterScaleAttribute(scale).follower;
}

function getCounterScaleAttribute(scale?: CounterScaleOptions):
    CounterScaleAttribute {
  switch (scale) {
    case 'MIN_MAX':
      return {
        follower: 'DELTA_FROM_PREVIOUS',
        tooltip: 'min/max',
        icon: 'show_chart',
      };
    case 'DELTA_FROM_PREVIOUS':
      return {follower: 'ZERO_BASED', tooltip: 'delta', icon: 'bar_chart'};
    case 'ZERO_BASED':
    default:
      return {
        follower: 'MIN_MAX',
        tooltip: 'zero based',
        icon: 'waterfall_chart',
      };
  }
}

class CounterTrack extends Track<Config, Data> {
  static readonly kind = COUNTER_TRACK_KIND;
  static create(args: NewTrackArgs): CounterTrack {
    return new CounterTrack(args);
  }

  private mousePos = {x: 0, y: 0};
  private hoveredValue: number|undefined = undefined;
  private hoveredTs: number|undefined = undefined;
  private hoveredTsEnd: number|undefined = undefined;

  constructor(args: NewTrackArgs) {
    super(args);
  }

  getHeight() {
    return MARGIN_TOP + RECT_HEIGHT;
  }

  getTrackShellButtons(): Array<m.Vnode<TrackButtonAttrs>> {
    const buttons: Array<m.Vnode<TrackButtonAttrs>> = [];
    buttons.push(m(TrackButton, {
      action: () => {
        this.config.scale = nextScale(this.config.scale);
        Actions.updateTrackConfig(
            {id: this.trackState.id, config: this.config});
        globals.rafScheduler.scheduleFullRedraw();
      },
      i: scaleIcon(this.config.scale),
      tooltip: scaleTooltip(this.config.scale),
      showButton: !!this.config.scale && this.config.scale !== 'ZERO_BASED',
    }));
    return buttons;
  }

  renderCanvas(ctx: CanvasRenderingContext2D): void {
    // TODO: fonts and colors should come from the CSS and not hardcoded here.
    const {timeScale, visibleWindowTime} = globals.frontendLocalState;
    const data = this.data();

    // Can't possibly draw anything.
    if (data === undefined || data.timestamps.length === 0) {
      return;
    }

    assertTrue(data.timestamps.length === data.minValues.length);
    assertTrue(data.timestamps.length === data.maxValues.length);
    assertTrue(data.timestamps.length === data.lastValues.length);
    assertTrue(data.timestamps.length === data.totalDeltas.length);

    const scale: CounterScaleOptions = this.config.scale || 'ZERO_BASED';

    let minValues = data.minValues;
    let maxValues = data.maxValues;
    let lastValues = data.lastValues;
    let maximumValue = data.maximumValue;
    let minimumValue = data.minimumValue;
    if (scale === 'DELTA_FROM_PREVIOUS') {
      lastValues = data.totalDeltas;
      minValues = data.totalDeltas;
      maxValues = data.totalDeltas;
      maximumValue = data.maximumDelta;
      minimumValue = data.minimumDelta;
    }

    const endPx = Math.floor(timeScale.timeToPx(visibleWindowTime.end));
    const zeroY = MARGIN_TOP + RECT_HEIGHT / (minimumValue < 0 ? 2 : 1);

    // Quantize the Y axis to quarters of powers of tens (7.5K, 10K, 12.5K).
    const maxValue = Math.max(maximumValue, 0);

    let yMax = Math.max(Math.abs(minimumValue), maxValue);
    const kUnits = ['', 'K', 'M', 'G', 'T', 'E'];
    const exp = Math.ceil(Math.log10(Math.max(yMax, 1)));
    const pow10 = Math.pow(10, exp);
    yMax = Math.ceil(yMax / (pow10 / 4)) * (pow10 / 4);
    let yRange = 0;
    const unitGroup = Math.floor(exp / 3);
    let yMin = 0;
    let yLabel = '';
    if (scale === 'MIN_MAX') {
      yRange = maximumValue - minimumValue;
      yMin = minimumValue;
      yLabel = 'min - max';
    } else {
      yRange = minimumValue < 0 ? yMax * 2 : yMax;
      yMin = minimumValue < 0 ? -yMax : 0;
      yLabel = `${yMax / Math.pow(10, unitGroup * 3)} ${kUnits[unitGroup]}`;
      if (scale === 'DELTA_FROM_PREVIOUS') {
        yLabel += '\u0394';
      }
    }

    // There are 360deg of hue. We want a scale that starts at green with
    // exp <= 3 (<= 1KB), goes orange around exp = 6 (~1MB) and red/violet
    // around exp >= 9 (1GB).
    // The hue scale looks like this:
    // 0                              180                                 360
    // Red        orange         green | blue         purple          magenta
    // So we want to start @ 180deg with pow=0, go down to 0deg and then wrap
    // back from 360deg back to 180deg.
    const expCapped = Math.min(Math.max(exp - 3), 9);
    const hue = (180 - Math.floor(expCapped * (180 / 6)) + 360) % 360;

    ctx.fillStyle = `hsl(${hue}, 45%, 75%)`;
    ctx.strokeStyle = `hsl(${hue}, 45%, 45%)`;

    const calculateX = (ts: number) => {
      return Math.floor(timeScale.timeToPx(ts));
    };
    const calculateY = (value: number) => {
      return MARGIN_TOP + RECT_HEIGHT -
          Math.round(((value - yMin) / yRange) * RECT_HEIGHT);
    };

    ctx.beginPath();
    ctx.moveTo(calculateX(data.timestamps[0]), zeroY);
    let lastDrawnY = zeroY;
    for (let i = 0; i < data.timestamps.length; i++) {
      const x = calculateX(data.timestamps[i]);
      const minY = calculateY(minValues[i]);
      const maxY = calculateY(maxValues[i]);
      const lastY = calculateY(lastValues[i]);

      ctx.lineTo(x, lastDrawnY);
      if (minY === maxY) {
        assertTrue(lastY === minY);
        ctx.lineTo(x, lastY);
      } else {
        ctx.lineTo(x, minY);
        ctx.lineTo(x, maxY);
        ctx.lineTo(x, lastY);
      }
      lastDrawnY = lastY;
    }
    ctx.lineTo(endPx, lastDrawnY);
    ctx.lineTo(endPx, zeroY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Draw the Y=0 dashed line.
    ctx.strokeStyle = `hsl(${hue}, 10%, 71%)`;
    ctx.beginPath();
    ctx.setLineDash([2, 4]);
    ctx.moveTo(0, zeroY);
    ctx.lineTo(endPx, zeroY);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '10px Roboto Condensed';

    if (this.hoveredValue !== undefined && this.hoveredTs !== undefined) {
      // TODO(hjd): Add units.
      let text = scale === 'DELTA_FROM_PREVIOUS' ? 'delta: ' : 'value: ';
      text += `${this.hoveredValue.toLocaleString()}`;

      ctx.fillStyle = `hsl(${hue}, 45%, 75%)`;
      ctx.strokeStyle = `hsl(${hue}, 45%, 45%)`;

      const xStart = Math.floor(timeScale.timeToPx(this.hoveredTs));
      const xEnd = this.hoveredTsEnd === undefined ?
          endPx :
          Math.floor(timeScale.timeToPx(this.hoveredTsEnd));
      const y = MARGIN_TOP + RECT_HEIGHT -
          Math.round(((this.hoveredValue - yMin) / yRange) * RECT_HEIGHT);

      // Highlight line.
      ctx.beginPath();
      ctx.moveTo(xStart, y);
      ctx.lineTo(xEnd, y);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.lineWidth = 1;

      // Draw change marker.
      ctx.beginPath();
      ctx.arc(
          xStart, y, 3 /* r*/, 0 /* start angle*/, 2 * Math.PI /* end angle*/);
      ctx.fill();
      ctx.stroke();

      // Draw the tooltip.
      this.drawTrackHoverTooltip(ctx, this.mousePos, text);
    }

    // Write the Y scale on the top left corner.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillRect(0, 0, 42, 16);
    ctx.fillStyle = '#666';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${yLabel}`, 5, 14);

    // TODO(hjd): Refactor this into checkerboardExcept
    {
      const endPx = timeScale.timeToPx(visibleWindowTime.end);
      const counterEndPx =
          Math.min(timeScale.timeToPx(this.config.endTs || Infinity), endPx);

      // Grey out RHS.
      if (counterEndPx < endPx) {
        ctx.fillStyle = '#0000001f';
        ctx.fillRect(counterEndPx, 0, endPx - counterEndPx, this.getHeight());
      }
    }

    // If the cached trace slices don't fully cover the visible time range,
    // show a gray rectangle with a "Loading..." label.
    checkerboardExcept(
        ctx,
        this.getHeight(),
        timeScale.timeToPx(visibleWindowTime.start),
        timeScale.timeToPx(visibleWindowTime.end),
        timeScale.timeToPx(data.start),
        timeScale.timeToPx(data.end));
  }

  onMouseMove(pos: {x: number, y: number}) {
    const data = this.data();
    if (data === undefined) return;
    this.mousePos = pos;
    const {timeScale} = globals.frontendLocalState;
    const time = timeScale.pxToTime(pos.x);

    const values = this.config.scale === 'DELTA_FROM_PREVIOUS' ?
        data.totalDeltas :
        data.lastValues;
    const [left, right] = searchSegment(data.timestamps, time);
    this.hoveredTs = left === -1 ? undefined : data.timestamps[left];
    this.hoveredTsEnd = right === -1 ? undefined : data.timestamps[right];
    this.hoveredValue = left === -1 ? undefined : values[left];
  }

  onMouseOut() {
    this.hoveredValue = undefined;
    this.hoveredTs = undefined;
  }

  onMouseClick({x}: {x: number}) {
    const data = this.data();
    if (data === undefined) return false;
    const {timeScale} = globals.frontendLocalState;
    const time = timeScale.pxToTime(x);
    const [left, right] = searchSegment(data.timestamps, time);
    if (left === -1) {
      return false;
    } else {
      const counterId = data.lastIds[left];
      if (counterId === -1) return true;
      globals.makeSelection(Actions.selectCounter({
        leftTs: toNs(data.timestamps[left]),
        rightTs: right !== -1 ? toNs(data.timestamps[right]) : -1,
        id: counterId,
        trackId: this.trackState.id,
      }));
      return true;
    }
  }
}

trackRegistry.register(CounterTrack);
