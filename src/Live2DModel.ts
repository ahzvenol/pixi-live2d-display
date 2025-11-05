import type { InternalModel, ModelSettings, MotionPriority } from "@/cubism-common";
import type { MotionManagerOptions } from "@/cubism-common/MotionManager";
import type { Live2DFactoryOptions } from "@/factory/Live2DFactory";
import { Live2DFactory } from "@/factory/Live2DFactory";
import type { Renderer, Texture, Ticker, Rectangle } from "@pixi/core";
import { Matrix, ObservablePoint, Point } from "@pixi/core";
import { Container } from "@pixi/display";
import { AlphaFilter } from "@pixi/filter-alpha";
import { Automator, type AutomatorOptions } from "./Automator";
import { Live2DTransform } from "./Live2DTransform";
import type { JSONObject } from "./types/helpers";
import { logger } from "./utils";

export interface Live2DModelOptions extends MotionManagerOptions, AutomatorOptions {
    overWriteBounds?: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
}

const tempPoint = new Point();
const tempMatrix = new Matrix();

export type Live2DConstructor = { new (options?: Live2DModelOptions): Live2DModel };

export class Live2DModel<IM extends InternalModel = InternalModel> extends Container {
    static from<M extends Live2DConstructor = typeof Live2DModel>(
        this: M,
        source: string | JSONObject | ModelSettings,
        options?: Live2DFactoryOptions,
    ): Promise<InstanceType<M>> {
        const model = new this(options) as InstanceType<M>;
        return Live2DFactory.setupLive2DModel(model, source, options).then(() => model);
    }

    static fromSync<M extends Live2DConstructor = typeof Live2DModel>(
        this: M,
        source: string | JSONObject | ModelSettings,
        options?: Live2DFactoryOptions,
    ): InstanceType<M> {
        const model = new this(options) as InstanceType<M>;
        Live2DFactory.setupLive2DModel(model, source, options)
            .then(options?.onLoad)
            .catch(options?.onError);
        return model;
    }

    static registerTicker(tickerClass: typeof Ticker): void {
        Automator["defaultTicker"] = tickerClass.shared;
    }

    tag = "Live2DModel(uninitialized)";
    internalModel!: IM;
    textures: Texture[] = [];
    transform = new Live2DTransform();
    anchor = new ObservablePoint(this.onAnchorChange, this, 0, 0) as ObservablePoint<any>;

    protected glContextID = -1;
    elapsedTime: DOMHighResTimeStamp = 0;
    deltaTime: DOMHighResTimeStamp = 0;

    automator: Automator;

    overrideBounds: { x0: number; y0: number; x1: number; y1: number } = {
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
    };

    private _alphaFilter: AlphaFilter;
    private _lastWorldAlpha: number = 1.0;

    constructor(options?: Live2DModelOptions) {
        super();

        this.automator = new Automator(this, options);

        this._alphaFilter = new AlphaFilter(1);
        this.filters = [this._alphaFilter];

        this.once("modelLoaded", () => this.init(options));
    }

    protected init(options?: Live2DModelOptions): void {
        this.tag = `Live2DModel(${this.internalModel.settings.name})`;

        if (options?.overWriteBounds) {
            this.overrideBounds = options.overWriteBounds;
        }
    }

    protected onAnchorChange(): void {
        this.pivot.set(
            this.anchor.x * this.internalModel.width,
            this.anchor.y * this.internalModel.height,
        );
    }

    motion(
        group: string,
        index?: number,
        priority?: MotionPriority,
        options: {
            sound?: string;
            volume?: number;
            expression?: number | string;
            resetExpression?: boolean;
            crossOrigin?: string;
            onFinish?: () => void;
            onError?: (e: Error) => void;
        } = {},
    ): Promise<boolean> {
        return index === undefined
            ? this.internalModel.motionManager.startRandomMotion(group, priority, options)
            : this.internalModel.motionManager.startMotion(group, index, priority, options);
    }

    stopMotions(): void {
        return this.internalModel.motionManager.stopAllMotions();
    }

    speak(
        sound: string,
        options: {
            volume?: number;
            expression?: number | string;
            resetExpression?: boolean;
            crossOrigin?: string;
            onFinish?: () => void;
            onError?: (e: Error) => void;
        } = {},
    ): Promise<boolean> {
        return this.internalModel.motionManager.speak(sound, options);
    }

    stopSpeaking(): void {
        return this.internalModel.motionManager.stopSpeaking();
    }

    expression(id?: number | string): Promise<boolean> {
        if (this.internalModel.motionManager.expressionManager) {
            return id === undefined
                ? this.internalModel.motionManager.expressionManager.setRandomExpression()
                : this.internalModel.motionManager.expressionManager.setExpression(id);
        }
        return Promise.resolve(false);
    }

    focus(x: number, y: number, instant = false): void {
        tempPoint.x = x;
        tempPoint.y = y;
        this.toModelPosition(tempPoint, tempPoint, true);
        const tx = (tempPoint.x / this.internalModel.originalWidth) * 2 - 1;
        const ty = (tempPoint.y / this.internalModel.originalHeight) * 2 - 1;
        const radian = Math.atan2(ty, tx);
        this.internalModel.focusController.focus(Math.cos(radian), -Math.sin(radian), instant);
    }

    tap(x: number, y: number): void {
        const hitAreaNames = this.hitTest(x, y);
        if (hitAreaNames.length) {
            logger.log(this.tag, `Hit`, hitAreaNames);
            this.emit("hit", hitAreaNames);
        }
    }

    hitTest(x: number, y: number): string[] {
        tempPoint.x = x;
        tempPoint.y = y;
        this.toModelPosition(tempPoint, tempPoint);
        return this.internalModel.hitTest(tempPoint.x, tempPoint.y);
    }

    toModelPosition(
        position: Point,
        result: Point = position.clone(),
        skipUpdate?: boolean,
    ): Point {
        if (!skipUpdate) {
            this._recursivePostUpdateTransform();
            if (!this.parent) {
                (this.parent as any) = this._tempDisplayObjectParent;
                this.displayObjectUpdateTransform();
                (this.parent as any) = null;
            } else {
                this.displayObjectUpdateTransform();
            }
        }
        this.transform.worldTransform.applyInverse(position, result);
        this.internalModel.localTransform.applyInverse(result, result);
        return result;
    }

    containsPoint(point: Point): boolean {
        return this.getBounds(true).contains(point.x, point.y);
    }

    protected _calculateBounds(): void {
        this._bounds.addFrame(
            this.transform,
            this.overrideBounds.x0,
            this.overrideBounds.y0,
            this.internalModel.width + this.overrideBounds.x1,
            this.internalModel.height + this.overrideBounds.y1,
        );
    }

    update(dt: DOMHighResTimeStamp): void {
        this.deltaTime += dt;
        this.elapsedTime += dt;
    }

    override _render(renderer: Renderer): void {
        if (this.worldAlpha !== this._lastWorldAlpha) {
            this._alphaFilter.alpha = this.worldAlpha;
            this._lastWorldAlpha = this.worldAlpha;
        }

        renderer.batch.reset();
        renderer.geometry.reset();
        renderer.shader.reset();
        renderer.state.reset();

        let shouldUpdateTexture = false;
        if (this.glContextID !== (renderer as any).CONTEXT_UID) {
            this.glContextID = (renderer as any).CONTEXT_UID;
            this.internalModel.updateWebGLContext(renderer.gl, this.glContextID);
            shouldUpdateTexture = true;
        }

        for (let i = 0; i < this.textures.length; i++) {
            const texture = this.textures[i]!;
            if (!texture.valid) continue;
            if (
                shouldUpdateTexture ||
                !(texture.baseTexture as any)._glTextures[this.glContextID]
            ) {
                renderer.gl.pixelStorei(
                    WebGLRenderingContext.UNPACK_FLIP_Y_WEBGL,
                    this.internalModel.textureFlipY,
                );
                renderer.texture.bind(texture.baseTexture, 0);
            }
            this.internalModel.bindTexture(
                i,
                (texture.baseTexture as any)._glTextures[this.glContextID].texture,
            );
            (texture.baseTexture as any).touched = renderer.textureGC.count;
        }

        const viewport = (renderer.framebuffer as any).viewport as Rectangle;
        this.internalModel.viewport = [viewport.x, viewport.y, viewport.width, viewport.height];

        if (this.deltaTime) {
            this.internalModel.update(this.deltaTime, this.elapsedTime);
            this.deltaTime = 0;
        }

        const internalTransform = tempMatrix
            .copyFrom(renderer.globalUniforms.uniforms.projectionMatrix)
            .append(this.worldTransform);

        this.internalModel.updateTransform(internalTransform);
        this.internalModel.draw(renderer.gl);

        renderer.state.reset();
        renderer.texture.reset();
    }

    destroy(options?: { children?: boolean; texture?: boolean; baseTexture?: boolean }): void {
        this.emit("destroy");

        if (options?.texture) {
            this.textures.forEach((texture) => texture.destroy(options.baseTexture));
        }

        this.automator.destroy();
        this.internalModel.destroy();

        super.destroy(options);
    }
}
