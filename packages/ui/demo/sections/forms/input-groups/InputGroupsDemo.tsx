import { BarChart3, HelpCircle, Mail, Search, Users } from 'lucide-preact';

export function InputGroupsDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With leading icon</h3>
        <div>
          <label for="email" class="block text-sm/6 font-medium text-text-primary">
            Email
          </label>
          <div class="mt-2 grid grid-cols-1">
            <input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              class="col-start-1 row-start-1 block w-full rounded-md bg-white py-1.5 pr-3 pl-10 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
            />
            <Mail
              aria-hidden="true"
              class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-gray-400 sm:size-4 dark:text-gray-500"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With trailing icon</h3>
        <div>
          <label for="account-number" class="block text-sm/6 font-medium text-text-primary">
            Account number
          </label>
          <div class="mt-2 grid grid-cols-1">
            <input
              id="account-number"
              name="account-number"
              type="text"
              placeholder="000-00-0000"
              class="col-start-1 row-start-1 block w-full rounded-md bg-white py-1.5 pr-10 pl-3 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:pr-9 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
            />
            <HelpCircle
              aria-hidden="true"
              class="pointer-events-none col-start-1 row-start-1 mr-3 size-5 self-center justify-self-end text-gray-400 sm:size-4 dark:text-gray-500"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          With inline leading and trailing add-ons
        </h3>
        <div>
          <label for="price" class="block text-sm/6 font-medium text-text-primary">
            Price
          </label>
          <div class="mt-2">
            <div class="flex items-center rounded-md bg-white px-3 outline-1 -outline-offset-1 outline-gray-300 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-600 dark:bg-white/5 dark:outline-white/10 dark:focus-within:outline-indigo-500">
              <div class="shrink-0 text-base text-gray-500 select-none sm:text-sm/6 dark:text-gray-400">
                $
              </div>
              <input
                id="price"
                name="price"
                type="text"
                placeholder="0.00"
                aria-describedby="price-currency"
                class="block min-w-0 grow bg-white py-1.5 pr-3 pl-1 text-base text-gray-900 placeholder:text-gray-400 focus:outline-none sm:text-sm/6 dark:bg-transparent dark:text-white dark:placeholder:text-gray-500"
              />
              <div
                id="price-currency"
                class="shrink-0 text-base text-gray-500 select-none sm:text-sm/6 dark:text-gray-400"
              >
                USD
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With leading dropdown</h3>
        <div>
          <label for="company-website" class="block text-sm/6 font-medium text-text-primary">
            Company website
          </label>
          <div class="mt-2 flex">
            <div class="flex shrink-0 items-center rounded-l-md bg-white px-3 text-base text-gray-500 outline-1 -outline-offset-1 outline-gray-300 sm:text-sm/6 dark:bg-white/5 dark:text-gray-400 dark:outline-gray-700">
              https://
            </div>
            <input
              id="company-website"
              name="company-website"
              type="text"
              placeholder="www.example.com"
              class="-ml-px block w-full grow rounded-r-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-gray-700 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          With leading icon and trailing button
        </h3>
        <div>
          <label for="query" class="block text-sm/6 font-medium text-text-primary">
            Search candidates
          </label>
          <div class="mt-2 flex">
            <div class="-mr-px grid grow grid-cols-1 focus-within:relative">
              <input
                id="query"
                name="query"
                type="text"
                placeholder="John Smith"
                class="col-start-1 row-start-1 block w-full rounded-l-md bg-white py-1.5 pr-3 pl-10 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:pl-9 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-gray-700 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
              />
              <Users
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-gray-400 sm:size-4 dark:text-gray-500"
              />
            </div>
            <button
              type="button"
              class="flex shrink-0 items-center gap-x-1.5 rounded-r-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 outline-1 -outline-offset-1 outline-gray-300 hover:bg-gray-50 focus:relative focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-white/10 dark:text-white dark:outline-gray-700 dark:hover:bg-white/20 dark:focus:outline-indigo-500"
            >
              <BarChart3 aria-hidden="true" class="-ml-0.5 size-4 text-gray-400" />
              Sort
            </button>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With search icon</h3>
        <div>
          <label for="search" class="block text-sm/6 font-medium text-text-primary">
            Search
          </label>
          <div class="mt-2 grid grid-cols-1">
            <input
              id="search"
              name="search"
              type="search"
              placeholder="Search..."
              class="col-start-1 row-start-1 block w-full rounded-md bg-white py-1.5 pr-3 pl-10 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
            />
            <Search
              aria-hidden="true"
              class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-gray-400 sm:size-4 dark:text-gray-500"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With inline add-on</h3>
        <div>
          <label for="website" class="block text-sm/6 font-medium text-text-primary">
            Website
          </label>
          <div class="mt-2 flex">
            <div class="flex shrink-0 items-center rounded-l-md bg-white px-3 text-base text-gray-500 outline-1 -outline-offset-1 outline-gray-300 sm:text-sm/6 dark:bg-white/5 dark:text-gray-400 dark:outline-gray-700">
              https://
            </div>
            <input
              id="website"
              name="website"
              type="text"
              placeholder="www.example.com"
              class="-ml-px block w-full grow rounded-r-md bg-white px-3 py-1.5 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-gray-700 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
