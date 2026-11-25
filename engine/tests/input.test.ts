import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { InputManager } from '../src/input/inputManager'

function keyboard(target: EventTarget, type: 'keydown' | 'keyup', code: string, repeat = false): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), { code, repeat })
  target.dispatchEvent(event)
  return event
}

function replaceGlobal(t: TestContext, name: 'navigator' | 'localStorage', descriptor: PropertyDescriptor): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, ...descriptor })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else Reflect.deleteProperty(globalThis, name)
  })
}

function setup(t: TestContext) {
  replaceGlobal(t, 'localStorage', { value: undefined })
  const target = new EventTarget()
  const input = new InputManager()
  input.attach(target)
  t.after(() => input.detach())
  return {
    input,
    target,
    down: (code: string, repeat = false) => keyboard(target, 'keydown', code, repeat),
    up: (code: string) => keyboard(target, 'keyup', code),
  }
}

function gamepad(t: TestContext) {
  const buttons: GamepadButton[] = Array.from({ length: 17 }, () => ({
    value: 0, pressed: false, touched: false,
  }))
  const pad = {
    id: 'test pad',
    index: 0,
    mapping: 'standard',
    connected: true as boolean,
    timestamp: 0,
    buttons,
    axes: [0, 0, 0, 0],
  } satisfies Omit<Gamepad, 'vibrationActuator'>
  replaceGlobal(t, 'navigator', { value: { getGamepads: () => [null, pad] } })
  return {
    pad,
    button: (index: number, value = 1, pressed = value === 1) => {
      buttons[index] = { value, pressed, touched: value > 0 }
    },
  }
}

test('driving keys report held levels and delimited edges', t => {
  const { input, down, up } = setup(t)
  assert.equal(down('KeyW').defaultPrevented, true)
  for (const code of ['KeyS', 'KeyA', 'Space', 'ControlRight', 'KeyV', 'KeyE', 'KeyQ', 'KeyC', 'Escape', 'KeyR']) {
    down(code)
  }
  // A full tap between polls still produces an edge.
  up('KeyR')
  const first = input.poll(0).driving
  assert.deepEqual(first, {
    throttle: 1, brake: 1, steer: -1, handbrake: true, boost: true,
    gearUpPressed: true, gearDownPressed: true, cameraNextPressed: true,
    lookBack: true, pausePressed: true, resetPressed: true, isAnalogSteer: false,
  })

  down('KeyE', true)
  down('KeyQ')
  down('Enter') // Same camera action while KeyC is held.
  down('KeyP') // Same pause action while Escape is held.
  const next = input.poll(0).driving
  assert.deepEqual(next, {
    throttle: 1, brake: 1, steer: -1, handbrake: true, boost: true,
    gearUpPressed: false, gearDownPressed: false, cameraNextPressed: false,
    lookBack: true, pausePressed: false, resetPressed: false, isAnalogSteer: false,
  })
  assert.equal(first.gearUpPressed, true)

  down('ArrowRight')
  assert.equal(input.poll(0).driving.steer, 0)
  up('KeyA')
  assert.equal(input.poll(0).driving.steer, 1)
  up('KeyE')
  down('KeyE')
  assert.equal(input.poll(0).driving.gearUpPressed, true)
})

test('menu directions repeat independently while confirm, back and anyKey stay edge-triggered', t => {
  const { input, down, up } = setup(t)
  down('ArrowUp')
  down('Enter')
  down('Escape')
  const first = input.poll(1).menu
  assert.equal(first.up, true)
  assert.equal(first.confirm, true)
  assert.equal(first.back, true)
  assert.equal(first.anyKey, true)

  assert.equal(input.poll(0.25).menu.up, false)
  down('ArrowUp', true)
  down('Enter', true)
  down('Escape', true)
  down('ArrowDown')
  const second = input.poll(0.15).menu
  assert.equal(second.up, true)
  assert.equal(second.down, true)
  assert.equal(second.confirm, false)
  assert.equal(second.back, false)

  const repeat = input.poll(0.36).menu
  assert.equal(repeat.up, true)
  assert.equal(repeat.down, false)
  assert.equal(repeat.anyKey, false)
  const next = input.poll(0.05).menu
  assert.equal(next.up, false)
  assert.equal(next.down, true)

  up('ArrowUp')
  assert.equal(input.poll(1).menu.up, false)
  down('ArrowUp')
  assert.equal(input.poll(0).menu.up, true)
  assert.equal(input.poll(0.39).menu.up, false)

  const unbound = down('KeyZ')
  up('KeyZ')
  assert.equal(unbound.defaultPrevented, false)
  assert.equal(input.poll(0).menu.anyKey, true)
  assert.equal(input.poll(0).menu.anyKey, false)
})

test('sustained navigation reaches a minimum repeat interval and skips missed repeats', t => {
  const { input, down } = setup(t)
  down('ArrowLeft')
  assert.equal(input.poll(0).menu.left, true)
  for (const delay of [0.4, 0.35, 0.3, 0.25, 0.2]) {
    assert.equal(input.poll(delay + 0.001).menu.left, true)
  }
  assert.equal(input.poll(0.15).menu.left, false)
  assert.equal(input.poll(0.02).menu.left, true)
  assert.equal(input.poll(2).menu.left, true)
  assert.equal(input.poll(0.02).menu.left, false)
})

test('standard gamepad maps triggers, held buttons, and menu and driving edges', t => {
  const { input } = setup(t)
  const { pad, button } = gamepad(t)
  button(7, 0.75)
  button(6, 0.25)
  for (const index of [0, 1, 3, 9, 12, 15]) button(index)
  const { driving, menu } = input.poll(0)
  assert.equal(driving.throttle, 0.75)
  assert.equal(driving.brake, 0.25)
  assert.equal(driving.handbrake, true)
  assert.equal(driving.boost, true)
  assert.equal(driving.cameraNextPressed, true)
  assert.equal(driving.pausePressed, true)
  assert.equal(driving.steer, 1)
  assert.equal(driving.isAnalogSteer, false)
  assert.equal(menu.up, true)
  assert.equal(menu.right, true)
  assert.equal(menu.confirm, true)
  assert.equal(menu.back, true)
  assert.equal(menu.anyKey, true)

  const held = input.poll(0.4)
  assert.equal(held.driving.cameraNextPressed, false)
  assert.equal(held.driving.pausePressed, false)
  assert.equal(held.menu.up, true)
  assert.equal(held.menu.right, true)
  assert.equal(held.menu.confirm, false)
  assert.equal(held.menu.back, false)
  assert.equal(held.menu.anyKey, false)

  button(0, 0)
  button(1, 0)
  button(2)
  button(5)
  assert.equal(input.poll(0).driving.handbrake, true)
  assert.equal(input.poll(0).driving.boost, true)
  pad.connected = false
  const disconnected = input.poll(0)
  assert.equal(disconnected.driving.throttle, 0)
  assert.equal(disconnected.driving.steer, 0)
  assert.equal(disconnected.driving.handbrake, false)
  assert.equal(disconnected.menu.up, false)
})

test('left stick deadzone rescales both directions and digital steering takes priority', t => {
  const { input, down, up } = setup(t)
  const { pad, button } = gamepad(t)

  for (const axis of [-0.15, 0, 0.15]) {
    pad.axes[0] = axis
    const { driving } = input.poll(0)
    assert.equal(driving.steer, 0)
    assert.equal(driving.isAnalogSteer, false)
  }

  for (const [axis, expected] of [[-1, -1], [-0.575, -0.5], [0.575, 0.5], [1, 1]] as const) {
    pad.axes[0] = axis
    const { driving } = input.poll(0)
    assert.ok(Math.abs(driving.steer - expected) < 1e-12)
    assert.equal(driving.isAnalogSteer, true)
  }

  down('ArrowLeft')
  assert.equal(input.poll(0).driving.steer, -1)
  assert.equal(input.poll(0).driving.isAnalogSteer, false)
  button(15)
  assert.equal(input.poll(0).driving.steer, 0)
  assert.equal(input.poll(0).driving.isAnalogSteer, false)
  up('ArrowLeft')
  pad.axes[0] = -1
  assert.equal(input.poll(0).driving.steer, 1)
  assert.equal(input.poll(0).driving.isAnalogSteer, false)
  button(15, 0)
  assert.equal(input.poll(0).driving.steer, -1)
  assert.equal(input.poll(0).driving.isAnalogSteer, true)
})

test('keyboard and gamepad rebinding persists and reset restores defaults', t => {
  const storage = new Map<string, string>()
  const { button } = gamepad(t)
  replaceGlobal(t, 'localStorage', {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  })

  const input = new InputManager()
  input.setBinding('throttle', ['KeyI', 'KeyI'])
  input.setBinding('menuConfirm', [])
  input.setGamepadBinding('gearUp', [4])
  assert.deepEqual(input.getBinding('throttle'), ['KeyI'])
  assert.deepEqual(input.getGamepadBinding('gearUp'), [4])

  const restored = new InputManager()
  const target = new EventTarget()
  restored.attach(target)
  t.after(() => restored.detach())
  keyboard(target, 'keydown', 'ArrowUp')
  keyboard(target, 'keydown', 'Enter')
  const defaultKeys = restored.poll(0)
  assert.equal(defaultKeys.driving.throttle, 0)
  assert.equal(defaultKeys.menu.up, true)
  assert.equal(defaultKeys.menu.confirm, false)

  keyboard(target, 'keydown', 'KeyI')
  button(4)
  const rebound = restored.poll(0)
  assert.equal(rebound.driving.throttle, 1)
  assert.equal(rebound.driving.gearUpPressed, true)
  assert.equal(restored.poll(0).driving.gearUpPressed, false)

  restored.resetBindings()
  assert.equal(new InputManager().getBinding('throttle').includes('ArrowUp'), true)
  assert.deepEqual(new InputManager().getGamepadBinding('gearUp'), [])
})

test('invalid saved entries fall back independently and blocked storage allows in-memory changes', t => {
  replaceGlobal(t, 'localStorage', {
    value: { getItem: () => '{"keyboard":{"throttle":[17],"brake":["KeyI"]},"gamepad":{"boost":[-1]}}' },
  })
  const input = new InputManager()
  assert.deepEqual(input.getBinding('throttle'), ['ArrowUp', 'KeyW'])
  assert.deepEqual(input.getBinding('brake'), ['KeyI'])
  assert.deepEqual(input.getGamepadBinding('boost'), [1, 5])

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => { throw new DOMException('Storage blocked', 'SecurityError') },
  })
  const blocked = new InputManager()
  blocked.setBinding('pause', ['KeyJ'])
  assert.deepEqual(blocked.getBinding('pause'), ['KeyJ'])
})

test('pointer position uses canvas CSS coordinates and click and movement last one frame', t => {
  const { input, target } = setup(t)
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: null },
    width: 1920,
    height: 1080,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 200 }),
  }) as unknown as HTMLCanvasElement
  input.attach(target, canvas)

  function pointer(type: string, clientX: number, clientY: number, button = 0) {
    canvas.dispatchEvent(Object.assign(new Event(type), { clientX, clientY, button }))
  }

  pointer('pointermove', 200, 150)
  const moved = input.poll(0).menu
  assert.equal(moved.pointerX, 0.25)
  assert.equal(moved.pointerY, 0.5)
  assert.equal(moved.pointerMoved, true)
  assert.equal(moved.pointerClicked, false)
  assert.equal(input.poll(0).menu.pointerMoved, false)

  pointer('click', 700, 25, 2)
  assert.equal(input.poll(0).menu.pointerClicked, false)
  pointer('click', 700, 25)
  const clicked = input.poll(0).menu
  assert.equal(clicked.pointerX, 1)
  assert.equal(clicked.pointerY, 0)
  assert.equal(clicked.pointerClicked, true)
  assert.equal(clicked.pointerMoved, false)
  assert.equal(input.poll(0).menu.pointerClicked, false)

  input.detach()
  pointer('click', 200, 150)
  const detached = input.poll(0).menu
  assert.equal(detached.pointerX, 0)
  assert.equal(detached.pointerClicked, false)
})

test('blur clears stale keys and reattach removes old listeners', t => {
  const { input, target, down } = setup(t)
  down('ArrowUp')
  down('KeyC')
  target.dispatchEvent(new Event('blur'))
  assert.equal(input.poll(0).driving.throttle, 0)
  assert.equal(input.poll(0).driving.cameraNextPressed, false)
  down('ArrowUp', true)
  assert.equal(input.poll(0).menu.up, false)

  const nextTarget = new EventTarget()
  input.attach(nextTarget)
  assert.equal(down('ArrowUp').defaultPrevented, false)
  assert.equal(input.poll(0).driving.throttle, 0)
  keyboard(nextTarget, 'keydown', 'ArrowUp')
  assert.equal(input.poll(0).menu.up, true)
  input.detach()
  assert.equal(input.poll(0).driving.throttle, 0)
})
