const bucket = new WeakMap();
const ITERATE_KEY = Symbol();

// get拦截函数中的receiver 代表谁在读取属性
// Reflect中的receiver，可以理解为函数调用过程中的this
// 所以两者结合使用就是为了保证正确的this上下文指向
const data = new Proxy(obj, {
  get(target, key, receiver) {
    track(target, key);
    if (Array.isArray(target) && arrayInstrumentations.hasOwnProperty(key)) {
      return Reflect.get(arrayInstrumentations, key, receiver);
    }
    return Reflect.get(target, key, receiver);
  },
  // in
  has(target, key) {
    track(target, key);
    return Reflect.has(target, key);
  },
  // for in
  ownKeys(target) {
    track(target, ITERATE_KEY);
    return Reflect.ownKeys(target);
  },
  deleteProperty(target, key) {
    const hadkey = Object.prototype.hasOwnProperty.call(target, key);
    const res = Reflect.deleteProperty(target, key);
    if (res && hadkey) {
      trigger(target, key, "DELETE");
    }
    return res;
  },
  set(target, key, newVal, receiver) {
    const oldVal = target[key];
    const type = Array.isArray(target)
      ? Number(key) < target.length
        ? "SET"
        : "ADD"
      : Object.prototype.hasOwnProperty.call(target, key)
      ? "SET"
      : "ADD";
    const res = Reflect.set(target, key, newVal, receiver);
    if (target === receiver.raw) {
      if (oldVal !== newVal && (oldVal === oldVal || newVal === newVal)) {
        trigger(target, key, type, newVal);
      }
    }
    return res;
  },
});

function track(target, key) {
  if (!activeEffect) return target[key];
  let depsMap = bucket.get(target);
  if (!depsMap) {
    bucket.set(target, (depsMap = new Map()));
  }
  let deps = depsMap.get(key);
  if (!deps) {
    depsMap.set(key, (deps = new Set()));
  }
  deps.add(activeEffect);
  activeEffect.deps.push(deps);
}

// 可调度性 有能力决定副作用函数执行的时机，次数以及方式
function trigger(target, key, type) {
  const depsMap = bucket.get(target);
  if (!depsMap) return;
  const effects = depsMap.get(key);
  const iterateEffects = depsMap.get(ITERATE_KEY);
  const effectsToRun = new Set();
  effects &&
    effects.forEach((effectFn) => {
      effectsToRun.add(effectFn);
    });
  if (type === "ADD" || type === "DELETE") {
    iterateEffects &&
      iterateEffects.forEach((effectFn) => {
        effectsToRun.add(effectFn);
      });
  }
  effectsToRun.forEach((effectFn) => {
    if (effectFn.options.scheduler) {
      effectFn.options.scheduler(effectFn);
    } else {
      effectFn();
    }
  });
  if (type === "ADD" && Array.isArray(target)) {
    const lengthEffects = depsMap.get("length");
    lengthEffects &&
      lengthEffects.forEach((effectFn) => {
        if (effectFn !== activeEffect) {
          effectsToRun.add(effectFn);
        }
      });
  }
  if (Array.isArray(target) && key === "length") {
    depsMap.forEach((effects, key) => {
      if (key >= newVal) {
        effects.forEach((effectFn) => {
          if (effectFn !== activeEffect) {
            effectsToRun.add(effectFn);
          }
        });
      }
    });
  }
}

function cleanup(effectFn) {
  for (let i = 0; i < effectFn.deps.length; i++) {
    const deps = effectFn.deps[i];
    deps.delete(effectFn);
  }
  effectFn.deps.length = 0;
}

let activeEffect;
// 解决嵌套的effect
const effectStack = [];
function effect(fn, options = {}) {
  const effectFn = () => {
    // 清除遗留的副作用函数
    cleanup(effectFn);
    activeEffect = effectFn;
    effectStack.push(effectFn);
    fn();
    effectStack.pop();
    activeEffect = effectStack[effectStack.length - 1];
  };
  effectFn.options = options;
  effectFn.deps = [];
  if (!options.lazy) {
    effectFn();
  }
  return effectFn;
}

const reactiveMap = new Map();
function reactive(obj) {
  const existionProxy = reactiveMap.get(obj);
  if (existionProxy) return existionProxy;
  const proxy = createReactive(obj);
  reactiveMap.set(obj, proxy);
  return proxy;
}

const arrayInstrumentations = {};
["includes", "indexOf", "lastIndexOf"].forEach((method) => {
  const originMethod = Array.prototype[method];
  arrayInstrumentations[method] = function (...args) {
    let res = originMethod.apply(this, args);
    if (res === false || res === -1) {
      res = originMethod.apply(this.raw, args);
    }
    return res;
  };
});

// push等方法的调用会间接读取length属性，最终导致调用栈溢出
let shouldTrack = true;
["push", "pop", "shift", "unshift", "splice"].forEach((method) => {
  const originMethod = Array.prototype[method];
  arrayInstrumentations[method] = function (...args) {
    shouldTrack = false;
    let res = originMethod.apply(this, args);
    shouldTrack = true;
    return res;
  };
});

// computed函数的执行会返回一个对象，该对象的value属性是一个访问器属性，只有当读取value的值时
// 才会执行effectFn并将其结果作为返回值返回
function computed(getter) {
  let value;
  let dirty = true;
  const effectFn = effect(getter, {
    lazy: true,
    scheduler() {
      if (!dirty) {
        dirty = true;
      }
    },
  });
  const obj = {
    get value() {
      if (dirty) {
        value = effectFn();
        dirty = false;
      }
      return value;
    },
  };
  return obj;
}

// watch就是观测一个响应式数据，当数据发生变化时通知并执行相应的回调函数
function watch(source, cb) {
  let getter;
  if (typeof source === "function") {
    getter = source;
  } else {
    getter = () => traverse(source);
  }
  let oldValue, newValue;
  const job = () => {
    newValue = effectFn();
    cb(newValue, oldValue);
    oldValue = newValue;
  };
  const effectFn = effect(() => getter(), {
    lazy: true,
    scheduler: job,
  });
  if (options.immediate) {
    job();
  } else {
    oldValue = effectFn();
  }
}

function traverse(value, seen = new Set()) {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const k in value) {
    traverse(value[k], seen);
  }
  return value;
}

function ref(val) {
  const wrapper = {
    value: val,
  };
  // 使用Object.defineProperty在wrapper对象上定义一个不可枚举的属性并设置为true
  // 区分一个数据是否是ref
  Object.defineProperty(wrapper, "_v_isRef", {
    value: true,
  });
  return reactive(wrapper);
}

// 解决响应丢失
function toRef(obj, key) {
  const wrapper = {
    get value() {
      return obj[key];
    },
    set value(val) {
      obj[key] = val;
    },
  };
  Object.defineProperty(wrapper, "_v_isRef", {
    value: true,
  });
  return wrapper;
}

function toRefs(obj) {
  const ret = {};
  for (const key in obj) {
    ret[key] = toRef(obj, key);
  }
  return ret;
}

// 自动脱ref
function proxyRefs(target) {
  return new Proxy(target, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return value._v_isRef ? value.value : value;
    },
    set(target, key, newValue, receiver) {
      const value = target[key];
      if (value._v_isRef) {
        value.value = newValue;
        return true;
      }
      return Reflect.set(target, key, newValue, receiver);
    },
  });
}

// 全局变量，存储当前正在被初始化的组件实例
let currentInstance = null;
function setCurrentInstance(instance) {
  currentInstance = instance;
}

function onMounted(fn) {
  if (currentInstance) {
    currentInstance.mounted.push(fn);
  } else {
    console.error();
  }
}

// setup函数只会在被挂载的时候执行一次，setup函数可能返回一个函数或者对象
function mountComponent(vnode, container, anchor) {
  const componentOptions = vnode.type;
  const {
    render,
    data,
    setup,
    beforeCreate,
    created,
    beforeMount,
    mounted,
    beforeUpdate,
    updated,
    props: propsOption,
  } = componentOptions;
  // 调用data得到原始数据，并调用reactive包装成响应式数据
  beforeCreate && beforeCreate();
  const state = reactive(data());
  const [props, attrs] = resolveProps(propsOption, vnode.props);
  const slots = vnode.children || {};
  const instance = {
    state,
    props: shallowReactive(props),
    isMounted: false,
    subTree: null,
    slots,
    mounted: [],
  };
  function emit(event, ...payload) {
    const eventName = `on${event[0].toUpperCase() + event.slice(1)}`;
    const handler = instance.props[eventName];
    if (handler) {
      handler(...payload);
    } else {
      console.error("");
    }
  }
  const setupContext = { attrs, emit, slots };
  setCurrentInstance(instance);
  const setupResult = setup(shallowReadonly(instance.props), setupContext);
  setCurrentInstance(null);
  let setupState = null;
  if (typeof setupResult === "function") {
    render = setupResult;
  } else {
    setupState = setupResult;
  }
  vnode.component = instance;
  const renderContext = new Proxy(instance, {
    get(t, k, r) {
      const { state, props, slots } = t;
      if (k === "$slots") return slots;
      if (state && k in state) {
        return state[k];
      } else if (k in props) {
        return props[k];
      } else if (setupState && k in setupState) {
        return setupState[k];
      } else {
        console.error("不存在");
      }
    },
    set(t, k, v, r) {
      const { state, props } = t;
      if (state && k in state) {
        state[k] = v;
      } else if (k in props) {
        console.warn();
      } else if (setupState && k in setupState) {
        setupState[k] = v;
      }
    },
  });
  created && created.call(renderContext);
  effect(
    () => {
      // 调用render函数时，将其this设置为state
      // 从而render函数内部可以通过this访问组件自身状态数据
      const subTree = render.call(state, state);
      if (!instance.isMounted) {
        beforeMount && beforeMount.call(state);
        patch(null, subTree, container, anchor);
        instance.isMounted = true;
        mounted && mounted.call(state);
        instance.mounted &&
          instance.mounted.forEach((hook) => hook.call(renderContext));
      } else {
        beforeUpdate && beforeUpdate.call(state);
        patch(instance.subTree, subTree, container, anchor);
        updated && updated.call(state);
      }
      instance.subTree = subTree;
    },
    {
      scheduler: queueJob,
    }
  );
}

// 更新组件的props
function patchComponent(n1, n2, anchor) {
  const instance = (n2.component = n1.component);
  const { props } = instance;
  if (hasPropsChanged(n1.props, n2.props)) {
    const [nextProps] = resolveProps(n2.type.props, n2.props);
    for (const k in nextProps) {
      props[k] = nextProps[k];
    }
  }
}

const queue = new Set();
let isFlushing = false;
const p = Promise.resolve();

function queueJob(job) {
  queue.add(job);
  if (!isFlushing) {
    isFlushing = true;
    p.then(() => {
      try {
        queue.forEach((job) => job());
      } finally {
        isFlushing = false;
        queue.clear = 0;
      }
    });
  }
}

function load(onError) {
  // 请求接口，Promise实例
  const p = fetch();
  return p.catch((err) => {
    return new Promise((resolve, reject) => {});
  });
}

// 异步组件 以异步的方式加载并渲染一个组件
function defineAsyncComponent(options) {
  if (typeof options === "function") {
    options = {
      loader: options,
    };
  }
  const { loader } = options;
  let InnerComp = null;
  return {
    name: "AsyncComponentWrapper",
    setup() {
      const loaded = ref(false);
      const error = shallowRef(null);
      const loading = ref(false);
      let loadingTimer = null;
      if (options.delay) {
        loadingTimer = setTimeout(() => {
          loading.value = true;
        }, options.delay);
      } else {
        loading.value = true;
      }
      const timeout = ref(false);
      loader()
        .then((c) => {
          InnerComp = c;
          loaded.value = true;
        })
        .catch((err) => (error.value = err))
        .finally(() => {
          loading.value = false;
          clearTimeout(loadingTimer);
        });
      let timer = null;
      if (options.timeout) {
        timer = setTimeout(() => {
          const err = new Error(`Async component`);
          error.value = err;
          timeout.value = true;
        }, options.timeout);
      }
      onUnmounted(() => clearTimeout(timer));
      const placeholder = { type: Text, children: "" };
      return () => {
        if (loaded.value) {
          return { type: InnerComp };
        } else if (timeout.value) {
          return options.errorComponent
            ? { type: options.errorComponent }
            : placeholder;
        }
        return placeholder;
      };
    },
  };
}

function dispatch(componentName, eventName, params) {
  var parent = this.$parent || this.$root;
  var name = parent.$options.componentName;
  while (parent && (!name || name !== componentName)) {
    parent = parent.$parent;
    if (parent) {
      name = parent.$options.componentName;
    }
  }
  if (parent) {
    parent.$emit.apply(parent, [eventName].concat(params));
  }
}

function broadcast(componentName, eventName, params) {
  this.$children.forEach((child) => {
    var name = child.$options.componentName;
    if (name === componentName) {
      child.$emit.apply(child, [eventName].concat(params));
    } else {
      broadcast.apply(child, [componentName, eventName].concat([params]));
    }
  });
}

let myInstanceof = (target, origin) => {
  while (target) {
    if (target.__proto__ === origin.prototype) {
      return true;
    }
    target = target.__proto__;
  }
  return false;
};
