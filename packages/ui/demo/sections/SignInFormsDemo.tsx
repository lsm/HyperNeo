import { Input, Button } from '../../src/mod.ts';

const inputClass =
  'block w-full rounded-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500';

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
      <path
        fill-rule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function Example1() {
  return (
    <div class="flex min-h-full flex-col justify-center px-6 py-12 lg:px-8">
      <div class="sm:mx-auto sm:w-full sm:max-w-sm">
        <h2 class="mt-10 text-center text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          Sign in to your account
        </h2>
      </div>

      <div class="mt-10 sm:mx-auto sm:w-full sm:max-w-sm">
        <form class="space-y-6" action="#" method="POST">
          <div>
            <label for="email" class="block text-sm/6 font-medium text-gray-900 dark:text-white">
              Email address
            </label>
            <div class="mt-2">
              <Input
                id="email"
                name="email"
                type="email"
                required
                autocomplete="email"
                placeholder="you@example.com"
                class={inputClass}
              />
            </div>
          </div>

          <div>
            <label for="password" class="block text-sm/6 font-medium text-gray-900 dark:text-white">
              Password
            </label>
            <div class="mt-2">
              <Input
                id="password"
                name="password"
                type="password"
                required
                autocomplete="current-password"
                placeholder="Enter your password"
                class={inputClass}
              />
            </div>
          </div>

          <div class="flex items-center justify-between">
            <div class="flex items-center">
              <input
                id="remember-me"
                name="remember-me"
                type="checkbox"
                class="grid grid-cols-[1fr] grid-rows-[1fr] w-4 h-4 rounded border-gray-300 text-indigo-600 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:border-white/10 dark:bg-white/5 dark:text-indigo-500 dark:focus:outline-indigo-500 dark:checked:bg-indigo-500 dark:checked:border-indigo-500 forced-colors:appearance-auto"
              />
              <svg
                viewBox="0 0 14 14"
                fill="none"
                class="col-start-1 row-start-1 w-4 h-4 appearance-none pointer-events-none"
              >
                <path
                  d="M3 7l3 3 5-5"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="[&:not([data-checked])]:hidden"
                />
              </svg>
              <label
                for="remember-me"
                class="ml-2 block text-sm text-gray-900 dark:text-white cursor-pointer"
              >
                Remember me
              </label>
            </div>
            <div class="text-sm">
              <a
                href="#"
                class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                Forgot password?
              </a>
            </div>
          </div>

          <div>
            <Button
              type="submit"
              class="w-full inline-flex items-center justify-center gap-3 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-indigo-500 dark:hover:bg-indigo-400 cursor-pointer"
            >
              Sign in
            </Button>
          </div>
        </form>

        <p class="mt-10 text-center text-sm text-gray-500 dark:text-gray-400">
          Not a member?{' '}
          <a
            href="#"
            class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Start a 14 day free trial
          </a>
        </p>
      </div>
    </div>
  );
}

function Example2() {
  return (
    <div class="flex min-h-full flex-col justify-center px-6 py-12 lg:px-8">
      <div class="sm:mx-auto sm:w-full sm:max-w-sm">
        <h2 class="mt-10 text-center text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          Sign in to your account
        </h2>
      </div>

      <div class="mt-10 sm:mx-auto sm:w-full sm:max-w-sm">
        <form class="space-y-6" action="#" method="POST">
          <div>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autocomplete="email"
              placeholder="Email address"
              aria-label="Email address"
              class={inputClass}
            />
          </div>

          <div>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autocomplete="current-password"
              placeholder="Password"
              aria-label="Password"
              class={inputClass}
            />
          </div>

          <div class="flex items-center justify-between">
            <div class="flex items-center">
              <input
                id="remember-me-2"
                name="remember-me"
                type="checkbox"
                class="grid grid-cols-[1fr] grid-rows-[1fr] w-4 h-4 rounded border-gray-300 text-indigo-600 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:border-white/10 dark:bg-white/5 dark:text-indigo-500 dark:focus:outline-indigo-500 dark:checked:bg-indigo-500 dark:checked:border-indigo-500 forced-colors:appearance-auto"
              />
              <svg
                viewBox="0 0 14 14"
                fill="none"
                class="col-start-1 row-start-1 w-4 h-4 appearance-none pointer-events-none"
              >
                <path
                  d="M3 7l3 3 5-5"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="[&:not([data-checked])]:hidden"
                />
              </svg>
              <label
                for="remember-me-2"
                class="ml-2 block text-sm text-gray-900 dark:text-white cursor-pointer"
              >
                Remember me
              </label>
            </div>
            <div class="text-sm">
              <a
                href="#"
                class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                Forgot password?
              </a>
            </div>
          </div>

          <div>
            <Button
              type="submit"
              class="w-full inline-flex items-center justify-center gap-3 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-indigo-500 dark:hover:bg-indigo-400 cursor-pointer"
            >
              Sign in
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Example3() {
  return (
    <div class="flex min-h-full flex-col justify-center lg:flex-row">
      <div class="flex min-h-full flex-col justify-center px-6 py-12 lg:w-1/2 lg:px-12 xl:w-5/12">
        <div class="sm:mx-auto sm:w-full sm:max-w-sm">
          <h2 class="mt-10 text-center text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            Sign in to your account
          </h2>
        </div>

        <div class="mt-10 sm:mx-auto sm:w-full sm:max-w-sm">
          <form class="space-y-6" action="#" method="POST">
            <div>
              <label for="email" class="block text-sm/6 font-medium text-gray-900 dark:text-white">
                Email address
              </label>
              <div class="mt-2">
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autocomplete="email"
                  placeholder="you@example.com"
                  class={inputClass}
                />
              </div>
            </div>

            <div>
              <label
                for="password"
                class="block text-sm/6 font-medium text-gray-900 dark:text-white"
              >
                Password
              </label>
              <div class="mt-2">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autocomplete="current-password"
                  placeholder="Enter your password"
                  class={inputClass}
                />
              </div>
            </div>

            <div class="flex items-center justify-between">
              <div class="flex items-center">
                <input
                  id="remember-me-3"
                  name="remember-me"
                  type="checkbox"
                  class="grid grid-cols-[1fr] grid-rows-[1fr] w-4 h-4 rounded border-gray-300 text-indigo-600 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:border-white/10 dark:bg-white/5 dark:text-indigo-500 dark:focus:outline-indigo-500 dark:checked:bg-indigo-500 dark:checked:border-indigo-500 forced-colors:appearance-auto"
                />
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  class="col-start-1 row-start-1 w-4 h-4 appearance-none pointer-events-none"
                >
                  <path
                    d="M3 7l3 3 5-5"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="[&:not([data-checked])]:hidden"
                  />
                </svg>
                <label
                  for="remember-me-3"
                  class="ml-2 block text-sm text-gray-900 dark:text-white cursor-pointer"
                >
                  Remember me
                </label>
              </div>
              <div class="text-sm">
                <a
                  href="#"
                  class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  Forgot password?
                </a>
              </div>
            </div>

            <div>
              <Button
                type="submit"
                class="w-full inline-flex items-center justify-center gap-3 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-indigo-500 dark:hover:bg-indigo-400 cursor-pointer"
              >
                Sign in
              </Button>
            </div>
          </form>

          <p class="mt-10 text-center text-sm text-gray-500 dark:text-gray-400">
            Not a member?{' '}
            <a
              href="#"
              class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              Start a 14 day free trial
            </a>
          </p>
        </div>
      </div>
      <div class="hidden lg:flex lg:w-1/2 xl:w-7/12 bg-gray-100 dark:bg-gray-800">
        <div class="w-full object-cover bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
          <div class="text-white text-center p-12">
            <h2 class="text-3xl font-bold mb-4">Welcome Back</h2>
            <p class="text-lg opacity-80">
              Sign in to access your dashboard and continue where you left off.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Example4() {
  return (
    <div class="flex min-h-full flex-col justify-center px-6 py-12 lg:px-8">
      <div class="sm:mx-auto sm:w-full sm:max-w-md">
        <h2 class="mt-10 text-center text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          Sign in to your account
        </h2>
      </div>

      <div class="mt-10 sm:mx-auto sm:w-full sm:max-w-md">
        <div class="bg-white px-6 py-8 shadow-xl ring-1 ring-gray-900/5 dark:bg-white/5 dark:ring-white/10 sm:rounded-xl">
          <form class="space-y-6" action="#" method="POST">
            <div>
              <label for="email" class="block text-sm/6 font-medium text-gray-900 dark:text-white">
                Email address
              </label>
              <div class="mt-2">
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autocomplete="email"
                  placeholder="you@example.com"
                  class={inputClass}
                />
              </div>
            </div>

            <div>
              <label
                for="password"
                class="block text-sm/6 font-medium text-gray-900 dark:text-white"
              >
                Password
              </label>
              <div class="mt-2">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autocomplete="current-password"
                  placeholder="Enter your password"
                  class={inputClass}
                />
              </div>
            </div>

            <div class="flex items-center justify-between">
              <div class="flex items-center">
                <input
                  id="remember-me-4"
                  name="remember-me"
                  type="checkbox"
                  class="grid grid-cols-[1fr] grid-rows-[1fr] w-4 h-4 rounded border-gray-300 text-indigo-600 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:border-white/10 dark:bg-white/5 dark:text-indigo-500 dark:focus:outline-indigo-500 dark:checked:bg-indigo-500 dark:checked:border-indigo-500 forced-colors:appearance-auto"
                />
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  class="col-start-1 row-start-1 w-4 h-4 appearance-none pointer-events-none"
                >
                  <path
                    d="M3 7l3 3 5-5"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="[&:not([data-checked])]:hidden"
                  />
                </svg>
                <label
                  for="remember-me-4"
                  class="ml-2 block text-sm text-gray-900 dark:text-white cursor-pointer"
                >
                  Remember me
                </label>
              </div>
              <div class="text-sm">
                <a
                  href="#"
                  class="font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  Forgot password?
                </a>
              </div>
            </div>

            <div>
              <Button
                type="submit"
                class="w-full inline-flex items-center justify-center gap-3 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-indigo-500 dark:hover:bg-indigo-400 cursor-pointer"
              >
                Sign in
              </Button>
            </div>
          </form>

          <div class="mt-6">
            <div class="relative">
              <div class="absolute inset-0 flex items-center">
                <div class="w-full border-t border-gray-300 dark:border-white/10" />
              </div>
              <div class="relative flex justify-center text-sm">
                <span class="bg-white px-2 text-gray-500 dark:bg-white/5 dark:text-gray-400">
                  Or continue with
                </span>
              </div>
            </div>

            <div class="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                class="inline-flex items-center justify-center gap-3 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20 cursor-pointer"
              >
                <GoogleIcon />
                Google
              </button>

              <button
                type="button"
                class="inline-flex items-center justify-center gap-3 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20 cursor-pointer"
              >
                <GitHubIcon />
                GitHub
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SignInFormsDemo() {
  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple sign-in</h3>
        <Example1 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple no-labels</h3>
        <Example2 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Split screen</h3>
        <Example3 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple card</h3>
        <Example4 />
      </div>
    </div>
  );
}
