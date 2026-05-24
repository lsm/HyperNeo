/**
 * Heroicons to Lucide icon name mapping
 *
 * Maps @heroicons/react icon names to their lucide-preact equivalents.
 * Size variants are not needed — lucide icons are size-agnostic via class="w-N h-N".
 *
 * Source heroicons: 66 unique icon names from Tailwind Application UI v4 reference examples
 */
export const heroiconToLucide: Record<string, string> = {
  // === Navigation & Actions ===
  Bars3Icon: 'Menu',
  HomeIcon: 'Home',
  UsersIcon: 'Users',
  FolderIcon: 'Folder',
  CalendarIcon: 'Calendar',
  CalendarDaysIcon: 'CalendarDays',
  BellIcon: 'Bell',
  InboxIcon: 'Inbox',
  Cog6ToothIcon: 'Settings', // cog6-tooth
  CogIcon: 'Cog',
  SettingsIcon: 'Settings',
  PlusIcon: 'Plus',
  PlusSmallIcon: 'Plus',
  MinusIcon: 'Minus',
  XMarkIcon: 'X',
  XCircleIcon: 'XCircle',
  CheckIcon: 'Check',
  CheckCircleIcon: 'CheckCircle',
  CheckBadgeIcon: 'BadgeCheck',

  // === Arrows & Navigation ===
  ArrowRightIcon: 'ArrowRight',
  ArrowLeftIcon: 'ArrowLeft',
  ArrowUpIcon: 'ArrowUp',
  ArrowDownIcon: 'ArrowDown',
  ArrowUpCircleIcon: 'ArrowUpCircle',
  ArrowDownCircleIcon: 'ArrowDownCircle',
  ArrowRightCircleIcon: 'ArrowRightCircle',
  ArrowLongRightIcon: 'ArrowRight',
  ArrowLongLeftIcon: 'ArrowLeft',
  ArrowPathIcon: 'ArrowRightLeft',
  ArrowUpTrayIcon: 'ArrowUpFromLine',
  ArrowDownTrayIcon: 'ArrowDownToLine',
  ChevronDownIcon: 'ChevronDown',
  ChevronLeftIcon: 'ChevronLeft',
  ChevronRightIcon: 'ChevronRight',
  ChevronUpDownIcon: 'ChevronsUpDown',

  // === Search & Input ===
  MagnifyingGlassIcon: 'Search',
  FunnelIcon: 'Filter',
  BarsArrowUpIcon: 'BarChart3',
  HashtagIcon: 'Hash',

  // === User & People ===
  UserIcon: 'User',
  UserCircleIcon: 'UserCircle',
  UserPlusIcon: 'UserPlus',
  AtSymbolIcon: 'AtSign',

  // === Content & Media ===
  DocumentIcon: 'File',
  DocumentDuplicateIcon: 'Copy',
  DocumentPlusIcon: 'FilePlus',
  PaperClipIcon: 'Paperclip',
  PhotoIcon: 'Image',
  VideoCameraIcon: 'Video',
  CameraIcon: 'Camera',
  ChatBubbleLeftIcon: 'MessageCircle',
  ChatBubbleBottomCenterTextIcon: 'MessageSquare',
  ChatBubbleLeftEllipsisIcon: 'MessageCircleMore',

  // === Communication ===
  EnvelopeIcon: 'Mail',
  EnvelopeOpenIcon: 'MailOpen',
  PhoneIcon: 'Phone',

  // === Editing ===
  PencilIcon: 'Pencil',
  PencilSquareIcon: 'PencilLine',
  TrashIcon: 'Trash',
  FolderPlusIcon: 'FolderPlus',

  // === Data & Charts ===
  ChartPieIcon: 'PieChart',
  ChartBarSquareIcon: 'BarChart3',
  TableCellsIcon: 'Table',
  CubeIcon: 'Box',
  ServerIcon: 'Server',
  DatabaseIcon: 'Database',

  // === Status & Feedback ===
  ExclamationCircleIcon: 'AlertCircle',
  ExclamationTriangleIcon: 'AlertTriangle',
  InformationCircleIcon: 'Info',
  QuestionMarkCircleIcon: 'HelpCircle',
  FaceSmileIcon: 'Smile',
  FaceFrownIcon: 'Frown',
  StarIcon: 'Star',

  // === Objects & Items ===
  TagIcon: 'Tag',
  BookmarkIcon: 'Bookmark',
  BriefcaseIcon: 'Briefcase',
  BanknotesIcon: 'Banknote',
  CreditCardIcon: 'CreditCard',
  CurrencyDollarIcon: 'DollarSign',
  ReceiptRefundIcon: 'Receipt',
  BaggageClaimIcon: 'BaggageClaim',

  // === Actions ===
  HeartIcon: 'Heart',
  HandThumbUpIcon: 'ThumbsUp',
  FlagIcon: 'Flag',
  MegaphoneIcon: 'Megaphone',
  LockClosedIcon: 'Lock',
  LockOpenIcon: 'LockOpen',
  CommandLineIcon: 'Command',
  CodeBracketIcon: 'Code',
  CursorArrowRaysIcon: 'MousePointer',
  FingerPrintIcon: 'Fingerprint',
  GlobeAmericasIcon: 'Globe',
  GlobeAltIcon: 'Globe',
  SignalIcon: 'Signal',
  FireIcon: 'Flame',
  LifebuoyIcon: 'LifeBuoy',
  AcademicCapIcon: 'GraduationCap',
  BuildingOfficeIcon: 'Building',
  // ToothIcon: 'Tooth', // No equivalent in lucide-preact
  ArchiveBoxIcon: 'Archive',
  ViewColumnsIcon: 'Columns3',
  LinkIcon: 'Link',
  MapPinIcon: 'MapPin',

  // === UI Elements ===
  EllipsisHorizontalIcon: 'Ellipsis',
  EllipsisVerticalIcon: 'EllipsisVertical',
  ClockIcon: 'Clock',

  // === Theme Icons ===
  SunIcon: 'Sun',
  MoonIcon: 'Moon',
};
