export interface DrivingInput {
  throttle: number
  brake: number
  steer: number
  handbrake: boolean
  boost: boolean
  gearUpPressed: boolean
  gearDownPressed: boolean
  cameraNextPressed: boolean
  lookBack: boolean
  pausePressed: boolean
  resetPressed: boolean
  isAnalogSteer: boolean
}

export interface MenuInput {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
  confirm: boolean
  back: boolean
  anyKey: boolean
  pointerX: number
  pointerY: number
  pointerMoved: boolean
  pointerClicked: boolean
}

export interface InputFrame {
  driving: DrivingInput
  menu: MenuInput
}

const defaultKeyboardBindings = {
  throttle: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  steerLeft: ['ArrowLeft', 'KeyA'],
  steerRight: ['ArrowRight', 'KeyD'],
  handbrake: ['Space'],
  boost: ['ControlRight', 'ShiftRight', 'ShiftLeft', 'KeyX'],
  cameraNext: ['Enter', 'KeyC'],
  lookBack: ['KeyB', 'KeyV'],
  pause: ['KeyP', 'Escape'],
  gearUp: ['KeyE'],
  gearDown: ['KeyQ'],
  reset: ['KeyR'],
  menuUp: ['ArrowUp'],
  menuDown: ['ArrowDown'],
  menuLeft: ['ArrowLeft'],
  menuRight: ['ArrowRight'],
  menuConfirm: ['Enter', 'Space'],
  menuBack: ['Escape', 'Backspace'],
} satisfies Record<string, readonly string[]>

export type InputAction = keyof typeof defaultKeyboardBindings
type Bindings<T> = Record<InputAction, readonly T[]>

const defaultGamepadBindings: Bindings<number> = {
  throttle: [7],
  brake: [6],
  steerLeft: [14],
  steerRight: [15],
  handbrake: [0, 2],
  boost: [1, 5],
  cameraNext: [3],
  lookBack: [],
  pause: [9],
  gearUp: [],
  gearDown: [],
  reset: [],
  menuUp: [12],
  menuDown: [13],
  menuLeft: [14],
  menuRight: [15],
  menuConfirm: [0],
  menuBack: [1],
}

const actions = Object.keys(defaultKeyboardBindings) as InputAction[]
type MenuDirection = 'menuUp' | 'menuDown' | 'menuLeft' | 'menuRight'

const storageKey = 'fr3.input.bindings.v1'
const stickDeadzone = 0.15
const initialRepeatDelay = 0.4
const minimumRepeatDelay = 1 / 6
const repeatDelayStep = 0.05

function isKeyCode(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isButtonIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function readBindings<T>(
  saved: unknown,
  defaults: Bindings<T>,
  isValid: (value: unknown) => value is T,
): Bindings<T> {
  const bindings = { ...defaults }
  if (typeof saved !== 'object' || saved === null) return bindings

  for (const action of actions) {
    const value: unknown = (saved as Record<string, unknown>)[action]
    if (Array.isArray(value) && value.every(isValid)) {
      bindings[action] = [...new Set(value)]
    }
  }
  return bindings
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function readStick(axis = 0): number {
  if (!Number.isFinite(axis) || Math.abs(axis) <= stickDeadzone) return 0
  const magnitude = clampUnit((Math.abs(axis) - stickDeadzone) / (1 - stickDeadzone))
  return Math.sign(axis) * magnitude
}

export class InputManager {
  private keyboard: Bindings<string> = { ...defaultKeyboardBindings }
  private gamepad: Bindings<number> = { ...defaultGamepadBindings }
  private target?: EventTarget
  private canvas?: HTMLCanvasElement
  private view?: Window
  private readonly heldKeys = new Set<string>()
  private readonly keyEdges = new Set<InputAction>()
  private anyKeyDown = false
  private previousButtons: readonly boolean[] = []
  private previousPad?: Pick<Gamepad, 'index' | 'id'>
  private readonly repeats = new Map<InputAction, { remaining: number; delay: number }>()
  private pointerX = 0
  private pointerY = 0
  private pointerMoved = false
  private pointerClicked = false

  constructor() {
    try {
      const stored = globalThis.localStorage?.getItem(storageKey)
      if (stored) {
        const data = JSON.parse(stored)
        this.keyboard = readBindings(data?.keyboard, defaultKeyboardBindings, isKeyCode)
        this.gamepad = readBindings(data?.gamepad, defaultGamepadBindings, isButtonIndex)
      }
    } catch {
      // Storage may be blocked or contain invalid JSON.
    }
  }

  getBinding(action: InputAction): readonly string[] {
    return [...this.keyboard[action]]
  }

  /** Replace an action's KeyboardEvent.code aliases. An empty list unbinds it. */
  setBinding(action: InputAction, codes: readonly string[]): void {
    this.keyboard[action] = [...new Set(codes.filter(isKeyCode))]
    this.clearActionEdge(action)
    this.saveBindings()
  }

  getGamepadBinding(action: InputAction): readonly number[] {
    return [...this.gamepad[action]]
  }

  /** Replace an action's standard button indices. Left stick X stays mapped to steering. */
  setGamepadBinding(action: InputAction, buttons: readonly number[]): void {
    this.gamepad[action] = [...new Set(buttons.filter(isButtonIndex))]
    this.clearActionEdge(action)
    this.saveBindings()
  }

  resetBindings(): void {
    this.keyboard = { ...defaultKeyboardBindings }
    this.gamepad = { ...defaultGamepadBindings }
    this.keyEdges.clear()
    this.repeats.clear()
    this.saveBindings()
  }

  attach(target: EventTarget, canvas?: HTMLCanvasElement): void {
    this.detach()
    this.target = target
    this.canvas = canvas
    this.view = canvas?.ownerDocument.defaultView ?? globalThis.window

    target.addEventListener('keydown', this.onKeyDown)
    target.addEventListener('keyup', this.onKeyUp)
    target.addEventListener('blur', this.onBlur)
    if (this.view !== target) this.view?.addEventListener('blur', this.onBlur)
    canvas?.addEventListener('pointermove', this.onPointerMove)
    canvas?.addEventListener('click', this.onClick)
  }

  detach(): void {
    this.target?.removeEventListener('keydown', this.onKeyDown)
    this.target?.removeEventListener('keyup', this.onKeyUp)
    this.target?.removeEventListener('blur', this.onBlur)
    if (this.view !== this.target) this.view?.removeEventListener('blur', this.onBlur)
    this.canvas?.removeEventListener('pointermove', this.onPointerMove)
    this.canvas?.removeEventListener('click', this.onClick)
    this.target = undefined
    this.canvas = undefined
    this.view = undefined
    this.onBlur()
    this.previousButtons = []
    this.previousPad = undefined
    this.pointerX = 0
    this.pointerY = 0
  }

  /** Sample both contexts once per frame. dt is elapsed time in seconds. */
  poll(dt: number): InputFrame {
    const pad = this.activeGamepad()
    const buttons = pad?.buttons.map(button => button.pressed) ?? []
    const previous = pad?.index === this.previousPad?.index && pad?.id === this.previousPad?.id
      ? this.previousButtons
      : []

    const held = (action: InputAction) =>
      this.keyHeld(action) || this.gamepad[action].some(index => buttons[index])
    const pressed = (action: InputAction) =>
      this.keyEdges.has(action) || (
        !this.keyHeld(action) &&
        !this.gamepad[action].some(index => previous[index]) &&
        this.gamepad[action].some(index => buttons[index])
      )
    const pedal = (action: 'throttle' | 'brake') => {
      if (this.keyHeld(action)) return 1
      let amount = 0
      for (const index of this.gamepad[action]) {
        const value = pad?.buttons[index]?.value ?? 0
        if (Number.isFinite(value)) amount = Math.max(amount, clampUnit(value))
      }
      return amount
    }

    // Digital controls take priority, including when opposite directions cancel.
    const left = held('steerLeft')
    const right = held('steerRight')
    const stick = readStick(pad?.axes[0])
    const isAnalogSteer = !left && !right && stick !== 0
    const driving: DrivingInput = {
      throttle: pedal('throttle'),
      brake: pedal('brake'),
      steer: isAnalogSteer ? stick : Number(right) - Number(left),
      handbrake: held('handbrake'),
      boost: held('boost'),
      gearUpPressed: pressed('gearUp'),
      gearDownPressed: pressed('gearDown'),
      cameraNextPressed: pressed('cameraNext'),
      lookBack: held('lookBack'),
      pausePressed: pressed('pause'),
      resetPressed: pressed('reset'),
      isAnalogSteer,
    }

    const elapsed = Number.isFinite(dt) ? Math.max(dt, 0) : 0
    const navigate = (direction: MenuDirection) =>
      this.repeatDirection(direction, held(direction), pressed(direction), elapsed)
    const menu: MenuInput = {
      up: navigate('menuUp'),
      down: navigate('menuDown'),
      left: navigate('menuLeft'),
      right: navigate('menuRight'),
      confirm: pressed('menuConfirm'),
      back: pressed('menuBack'),
      anyKey: this.anyKeyDown || buttons.some((down, index) => down && !previous[index]),
      pointerX: this.pointerX,
      pointerY: this.pointerY,
      pointerMoved: this.pointerMoved,
      pointerClicked: this.pointerClicked,
    }

    this.keyEdges.clear()
    this.anyKeyDown = false
    this.previousButtons = buttons
    this.previousPad = pad && { index: pad.index, id: pad.id }
    this.pointerMoved = false
    this.pointerClicked = false
    return { driving, menu }
  }

  private keyHeld(action: InputAction): boolean {
    return this.keyboard[action].some(code => this.heldKeys.has(code))
  }

  private clearActionEdge(action: InputAction): void {
    this.keyEdges.delete(action)
    this.repeats.delete(action)
  }

  private activeGamepad(): Gamepad | undefined {
    if (!this.target) return
    try {
      const pads = (this.view?.navigator ?? globalThis.navigator)?.getGamepads?.()
      return Array.from(pads ?? []).find(pad => pad?.connected && pad.mapping === 'standard') ?? undefined
    } catch {
      // Gamepad access may be unavailable in this context.
      return undefined
    }
  }

  private repeatDirection(direction: MenuDirection, held: boolean, pressed: boolean, dt: number): boolean {
    if (!held) {
      this.repeats.delete(direction)
      return pressed
    }

    const repeat = this.repeats.get(direction)
    if (pressed || !repeat) {
      this.repeats.set(direction, { remaining: initialRepeatDelay, delay: initialRepeatDelay })
      return pressed
    }

    repeat.remaining -= dt
    if (repeat.remaining > 1e-9) return false
    repeat.delay = Math.max(minimumRepeatDelay, repeat.delay - repeatDelayStep)
    // A slow frame emits one navigation event, with no catch-up burst.
    repeat.remaining = repeat.remaining > -repeat.delay
      ? repeat.remaining + repeat.delay
      : repeat.delay
    return true
  }

  private saveBindings(): void {
    try {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify({
        keyboard: this.keyboard,
        gamepad: this.gamepad,
      }))
    } catch {
      // Binding edits still apply for this session.
    }
  }

  private readonly onKeyDown = (event: Event): void => {
    const { code, repeat } = event as KeyboardEvent
    if (!isKeyCode(code)) return
    const boundActions = actions.filter(action => this.keyboard[action].includes(code))
    if (boundActions.length) event.preventDefault()
    if (repeat || this.heldKeys.has(code)) return

    for (const action of boundActions) {
      if (!this.keyHeld(action) && !this.gamepad[action].some(index => this.previousButtons[index])) {
        this.keyEdges.add(action)
      }
    }
    this.heldKeys.add(code)
    this.anyKeyDown = true
  }

  private readonly onKeyUp = (event: Event): void => {
    this.heldKeys.delete((event as KeyboardEvent).code)
  }

  private readonly onBlur = (): void => {
    this.heldKeys.clear()
    this.keyEdges.clear()
    this.repeats.clear()
    this.anyKeyDown = false
    this.pointerMoved = false
    this.pointerClicked = false
  }

  private updatePointer(event: MouseEvent): boolean {
    const rect = this.canvas?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return false
    this.pointerX = clampUnit((event.clientX - rect.left) / rect.width)
    this.pointerY = clampUnit((event.clientY - rect.top) / rect.height)
    return true
  }

  private readonly onPointerMove = (event: Event): void => {
    if (this.updatePointer(event as PointerEvent)) this.pointerMoved = true
  }

  private readonly onClick = (event: Event): void => {
    const click = event as MouseEvent
    if (click.button === 0 && this.updatePointer(click)) this.pointerClicked = true
  }
}
