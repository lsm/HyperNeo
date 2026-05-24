import { useState } from 'preact/hooks';
import { Textarea } from '../../src/mod.ts';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '../../src/mod.ts';
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '../../src/mod.ts';
import { Paperclip, Calendar, Tag, UserCircle, Smile, Frown, Flame, Heart } from 'lucide-preact';

const commentFormClass =
  'rounded-lg bg-white outline-1 -outline-offset-1 outline-gray-300 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-600 dark:bg-white/5 dark:outline-white/10 dark:focus-within:outline-indigo-500';

const underlineClass =
  'border-b border-gray-200 pb-px focus-within:border-b-2 focus-within:border-indigo-600 focus-within:pb-0 dark:border-white/10 dark:focus-within:border-indigo-500';

const moods = [
  { id: 'happy', label: 'Happy', icon: <Smile class="w-4 h-4 text-green-500" /> },
  { id: 'neutral', label: 'Neutral', icon: <Smile class="w-4 h-4 text-yellow-500" /> },
  { id: 'sad', label: 'Sad', icon: <Frown class="w-4 h-4 text-red-500" /> },
  { id: 'excited', label: 'Excited', icon: <Flame class="w-4 h-4 text-orange-500" /> },
  { id: 'thankful', label: 'Thankful', icon: <Heart class="w-4 h-4 text-pink-500" /> },
];

function Example1() {
  return (
    <div class="space-y-2">
      <label for="comment" class="block text-sm font-medium text-gray-900 dark:text-white">
        Add your comment
      </label>
      <div class="rounded-lg bg-white outline-1 -outline-offset-1 outline-gray-300 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-600 dark:bg-white/5 dark:outline-white/10 dark:focus-within:outline-indigo-500">
        <Textarea
          id="comment"
          rows={4}
          class="block w-full rounded-t-lg border-0 px-3 py-2 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:placeholder:text-gray-500"
          placeholder="What are you thinking?"
        />
      </div>
    </div>
  );
}

function Example2() {
  const [selectedMood, setSelectedMood] = useState<(typeof moods)[0] | null>(null);

  return (
    <div class="space-y-3">
      <div class={commentFormClass}>
        <div class="flex gap-3 p-3">
          <div class="flex-shrink-0">
            <div class="h-9 w-9 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-sm font-medium">
              YD
            </div>
          </div>
          <div class="min-w-0 flex-1">
            <Textarea
              rows={3}
              class="block w-full border-0 px-0 py-0 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0 sm:text-sm/6 dark:bg-transparent dark:text-white dark:placeholder:text-gray-500"
              placeholder="Add your comment..."
            />
          </div>
        </div>
        <div class="flex items-center justify-between gap-3 border-t border-gray-200 px-3 py-2 dark:border-white/10">
          <div class="flex items-center gap-2">
            <Listbox value={selectedMood} onChange={setSelectedMood} by="id">
              <div class="relative">
                <ListboxButton class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10 cursor-pointer outline-none data-[focus]:bg-gray-100 dark:data-[focus]:bg-white/10">
                  {selectedMood ? (
                    <>
                      {selectedMood.icon}
                      <span>{selectedMood.label}</span>
                    </>
                  ) : (
                    <>
                      <Smile class="w-4 h-4" />
                      <span>Add mood</span>
                    </>
                  )}
                </ListboxButton>
                <ListboxOptions class="absolute left-0 top-full mt-1 w-40 bg-surface-1 rounded-lg border border-surface-border shadow-xl p-1 z-10 outline-none">
                  {moods.map((mood) => (
                    <ListboxOption
                      key={mood.id}
                      value={mood}
                      class="group flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer data-[focus]:bg-accent-500 data-[focus]:text-white data-[selected]:bg-accent-500 data-[selected]:text-white transition-colors"
                    >
                      {mood.icon}
                      <span class="flex-1 text-text-primary group-data-[focus]:text-white group-data-[selected]:text-white">
                        {mood.label}
                      </span>
                    </ListboxOption>
                  ))}
                </ListboxOptions>
              </div>
            </Listbox>
            <button
              type="button"
              class="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-500 dark:hover:bg-white/10 dark:hover:text-gray-300"
            >
              <Paperclip class="w-4 h-4" />
            </button>
          </div>
          <button
            type="button"
            class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-2 focus:outline-offset-2 focus:outline-indigo-600"
          >
            Post
          </button>
        </div>
      </div>
    </div>
  );
}

function Example3() {
  const [selectedMood, setSelectedMood] = useState<(typeof moods)[0] | null>(null);

  return (
    <div class="space-y-3">
      <div class={underlineClass}>
        <div class="flex gap-3 py-3">
          <div class="flex-shrink-0">
            <div class="h-9 w-9 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center text-white text-sm font-medium">
              KL
            </div>
          </div>
          <div class="min-w-0 flex-1">
            <Textarea
              rows={2}
              class="block w-full border-0 px-0 py-0 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0 sm:text-sm/6 dark:bg-transparent dark:text-white dark:placeholder:text-gray-500"
              placeholder="Add your comment..."
            />
          </div>
        </div>
      </div>
      <div class="flex items-center justify-between gap-3 pl-12">
        <div class="flex items-center gap-2">
          <Listbox value={selectedMood} onChange={setSelectedMood} by="id">
            <div class="relative">
              <ListboxButton class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10 cursor-pointer outline-none data-[focus]:bg-gray-100 dark:data-[focus]:bg-white/10">
                {selectedMood ? (
                  <>
                    {selectedMood.icon}
                    <span>{selectedMood.label}</span>
                  </>
                ) : (
                  <>
                    <Smile class="w-4 h-4" />
                    <span>Add mood</span>
                  </>
                )}
              </ListboxButton>
              <ListboxOptions class="absolute left-0 top-full mt-1 w-40 bg-surface-1 rounded-lg border border-surface-border shadow-xl p-1 z-10 outline-none">
                {moods.map((mood) => (
                  <ListboxOption
                    key={mood.id}
                    value={mood}
                    class="group flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer data-[focus]:bg-accent-500 data-[focus]:text-white data-[selected]:bg-accent-500 data-[selected]:text-white transition-colors"
                  >
                    {mood.icon}
                    <span class="flex-1 text-text-primary group-data-[focus]:text-white group-data-[selected]:text-white">
                      {mood.label}
                    </span>
                  </ListboxOption>
                ))}
              </ListboxOptions>
            </div>
          </Listbox>
          <button
            type="button"
            class="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-500 dark:hover:bg-white/10 dark:hover:text-gray-300"
          >
            <Paperclip class="w-4 h-4" />
          </button>
        </div>
        <button
          type="button"
          class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-2 focus:outline-offset-2 focus:outline-indigo-600"
        >
          Post
        </button>
      </div>
    </div>
  );
}

function Example4() {
  const [assignee, setAssignee] = useState<{ id: string; name: string } | null>(null);
  const [label, setLabel] = useState<{ id: string; name: string } | null>(null);

  const assignees = [
    { id: '1', name: 'Alice Johnson' },
    { id: '2', name: 'Bob Smith' },
    { id: '3', name: 'Carol Williams' },
    { id: '4', name: 'David Lee' },
  ];

  const labels = [
    { id: 'bug', name: 'Bug' },
    { id: 'feature', name: 'Feature' },
    { id: 'enhancement', name: 'Enhancement' },
    { id: 'docs', name: 'Documentation' },
  ];

  return (
    <div class="space-y-4">
      <input
        type="text"
        class="block w-full rounded-md bg-white px-3 py-2 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
        placeholder="Issue title"
      />
      <div class="rounded-lg bg-white outline-1 -outline-offset-1 outline-gray-300 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-indigo-600 dark:bg-white/5 dark:outline-white/10 dark:focus-within:outline-indigo-500">
        <Textarea
          rows={4}
          class="block w-full rounded-t-lg border-0 px-3 py-2 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:placeholder:text-gray-500"
          placeholder="Add a description..."
        />
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <Listbox value={assignee} onChange={setAssignee} by="id">
          <div class="relative">
            <ListboxButton class="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-500 hover:border-gray-300 dark:border-white/20 dark:bg-white/5 dark:text-gray-400 dark:hover:border-white/30 cursor-pointer outline-none data-[focus]:border-indigo-500">
              <UserCircle class="w-4 h-4" />
              {assignee ? assignee.name : 'Assign'}
            </ListboxButton>
            <ListboxOptions class="absolute left-0 top-full mt-1 w-48 bg-surface-1 rounded-lg border border-surface-border shadow-xl p-1 z-10 outline-none">
              {assignees.map((a) => (
                <ListboxOption
                  key={a.id}
                  value={a}
                  class="group flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer data-[focus]:bg-accent-500 data-[focus]:text-white data-[selected]:bg-accent-500 data-[selected]:text-white transition-colors"
                >
                  <UserCircle class="w-4 h-4 text-gray-400 group-data-[focus]:text-white group-data-[selected]:text-white" />
                  <span class="flex-1 text-text-primary group-data-[focus]:text-white group-data-[selected]:text-white">
                    {a.name}
                  </span>
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>

        <Listbox value={label} onChange={setLabel} by="id">
          <div class="relative">
            <ListboxButton class="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-500 hover:border-gray-300 dark:border-white/20 dark:bg-white/5 dark:text-gray-400 dark:hover:border-white/30 cursor-pointer outline-none data-[focus]:border-indigo-500">
              <Tag class="w-4 h-4" />
              {label ? label.name : 'Label'}
            </ListboxButton>
            <ListboxOptions class="absolute left-0 top-full mt-1 w-40 bg-surface-1 rounded-lg border border-surface-border shadow-xl p-1 z-10 outline-none">
              {labels.map((l) => (
                <ListboxOption
                  key={l.id}
                  value={l}
                  class="group flex items-center gap-2 px-3 py-2 rounded text-sm cursor-pointer data-[focus]:bg-accent-500 data-[focus]:text-white data-[selected]:bg-accent-500 data-[selected]:text-white transition-colors"
                >
                  <Tag class="w-4 h-4 text-gray-400 group-data-[focus]:text-white group-data-[selected]:text-white" />
                  <span class="flex-1 text-text-primary group-data-[focus]:text-white group-data-[selected]:text-white">
                    {l.name}
                  </span>
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>

        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-500 hover:border-gray-300 dark:border-white/20 dark:bg-white/5 dark:text-gray-400 dark:hover:border-white/30 cursor-pointer outline-none data-[focus]:border-indigo-500"
        >
          <Calendar class="w-4 h-4" />
          Due date
        </button>
      </div>
    </div>
  );
}

function Example5() {
  const [content, setContent] = useState('');

  return (
    <div class="space-y-3">
      <TabGroup>
        <TabList class="flex border-b border-gray-200 dark:border-white/10 gap-0">
          <Tab class="px-4 py-2 text-sm font-medium text-gray-500 border-b-2 border-transparent -mb-px hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300 cursor-pointer data-[selected]:border-indigo-500 data-[selected]:text-indigo-600 dark:data-[selected]:text-indigo-400 outline-none">
            Write
          </Tab>
          <Tab class="px-4 py-2 text-sm font-medium text-gray-500 border-b-2 border-transparent -mb-px hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300 cursor-pointer data-[selected]:border-indigo-500 data-[selected]:text-indigo-600 dark:data-[selected]:text-indigo-400 outline-none">
            Preview
          </Tab>
        </TabList>
        <TabPanels>
          <TabPanel class="pt-3 outline-none">
            <div class={commentFormClass}>
              <Textarea
                rows={4}
                class="block w-full rounded-t-lg border-0 px-3 py-2 text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-0 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:placeholder:text-gray-500"
                placeholder="Write your comment..."
                value={content}
                onInput={(e: Event) => setContent((e.target as HTMLTextAreaElement).value)}
              />
              <div class="flex items-center justify-between gap-3 border-t border-gray-200 px-3 py-2 dark:border-white/10">
                <button
                  type="button"
                  class="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-500 dark:hover:bg-white/10 dark:hover:text-gray-300"
                >
                  <Paperclip class="w-4 h-4" />
                </button>
                <button
                  type="button"
                  class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-2 focus:outline-offset-2 focus:outline-indigo-600"
                >
                  Post Comment
                </button>
              </div>
            </div>
          </TabPanel>
          <TabPanel class="pt-3 outline-none">
            <div class="rounded-lg bg-white px-3 py-2 text-sm text-gray-900 dark:bg-white/5 dark:text-white min-h-[100px]">
              {content ? (
                <p class="whitespace-pre-wrap">{content}</p>
              ) : (
                <p class="text-gray-400 italic">Nothing to preview.</p>
              )}
            </div>
          </TabPanel>
        </TabPanels>
      </TabGroup>
    </div>
  );
}

export function TextareasDemo() {
  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple textarea</h3>
        <Example1 />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Textarea with avatar and actions
        </h3>
        <Example2 />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Textarea with underline and actions
        </h3>
        <Example3 />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Textarea with title and pill actions
        </h3>
        <Example4 />
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Textarea with preview button</h3>
        <Example5 />
      </div>
    </div>
  );
}
