// Usage bar: a 6 px rounded track with an animated fill. Colours
// come from CSS classes (cas-bar-ok/warn/crit), never from code.
//
// The fill width is computed in vfunc_allocate from a fraction, so it is
// always right for the real track width (theme switches, font changes…).
// Animations interpolate the fraction with a Clutter.Timeline.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

const ANIM_MS = 450;
const MIN_FILL_PX = 6;
const easeOutCubic = t => 1 - (1 - t) ** 3;

export const UsageBar = GObject.registerClass(
class UsageBar extends St.Widget {
    _init() {
        super._init({
            style_class: 'cas-bar-track',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({style_class: 'cas-bar-fill cas-bar-none'});
        this.add_child(this._fill);
        this._frac = 0;
        this._level = 'none';
        this._timeline = null;
        this.connect('destroy', () => this._stop());
    }

    _stop() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }
    }

    /**
     * @param {number} pct 0-100
     * @param {string} level ok | warn | crit | none
     * @param {boolean} [animate]
     */
    setValue(pct, level, animate = true) {
        const to = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
        if (level !== this._level) {
            this._fill.remove_style_class_name(`cas-bar-${this._level}`);
            this._fill.add_style_class_name(`cas-bar-${level}`);
            this._level = level;
        }
        this._stop();
        const from = this._frac;
        if (!animate || from === to || !this.mapped) {
            this._frac = to;
            this.queue_relayout();
            return;
        }
        const tl = new Clutter.Timeline({actor: this, duration: ANIM_MS});
        tl.connect('new-frame', () => {
            this._frac = from + (to - from) * easeOutCubic(tl.get_progress());
            this.queue_relayout();
        });
        tl.connect('completed', () => {
            this._frac = to;
            this._timeline = null;
            this.queue_relayout();
        });
        this._timeline = tl;
        tl.start();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const w = box.get_width();
        const h = box.get_height();
        let fw = Math.round(w * this._frac);
        if (this._frac > 0)
            fw = Math.max(fw, Math.min(MIN_FILL_PX, w));
        const child = new Clutter.ActorBox();
        child.set_origin(0, 0);
        child.set_size(fw, h);
        this._fill.allocate(child);
    }
});
