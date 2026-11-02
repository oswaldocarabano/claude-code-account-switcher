// A small, version-independent spinner: a symbolic icon rotating with a
// Clutter transition. GNOME Shell's internal Animation.Spinner loads a sliced
// SVG sprite whose behaviour differs between Shell/librsvg versions.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';

export const Spinner = GObject.registerClass(
class Spinner extends St.Icon {
    /**
     * @param {number} size icon size in px
     * @param {{hideOnStop?: boolean}} [o]
     */
    _init(size, {hideOnStop = false} = {}) {
        super._init({
            icon_name: 'process-working-symbolic',
            icon_size: size,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._hideOnStop = hideOnStop;
        this._playing = false;
        this.visible = !hideOnStop;
    }

    play() {
        this.show();
        if (this._playing)
            return;
        this._playing = true;
        this.rotation_angle_z = 0;
        this.ease({
            rotation_angle_z: 360,
            duration: 900,
            mode: Clutter.AnimationMode.LINEAR,
            repeatCount: -1,
        });
    }

    stop() {
        this._playing = false;
        this.remove_all_transitions();
        this.rotation_angle_z = 0;
        if (this._hideOnStop)
            this.hide();
    }
});
