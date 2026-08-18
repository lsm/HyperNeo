import { describe, expect, test } from 'vitest';
import { heroiconToLucide } from '../demo/icon-map.ts';
import * as lucideIcons from 'lucide-preact';

describe('heroiconToLucide', () => {
  test('exports a record with string keys and values', () => {
    expect(typeof heroiconToLucide).toBe('object');
    expect(Object.keys(heroiconToLucide).length).toBeGreaterThan(0);
  });

  test('maps common navigation icons', () => {
    expect(heroiconToLucide['HomeIcon']).toBe('Home');
    expect(heroiconToLucide['UsersIcon']).toBe('Users');
    expect(heroiconToLucide['FolderIcon']).toBe('Folder');
    expect(heroiconToLucide['CalendarIcon']).toBe('Calendar');
    expect(heroiconToLucide['BellIcon']).toBe('Bell');
  });

  test('maps action icons', () => {
    expect(heroiconToLucide['PlusIcon']).toBe('Plus');
    expect(heroiconToLucide['XMarkIcon']).toBe('X');
    expect(heroiconToLucide['CheckIcon']).toBe('Check');
    expect(heroiconToLucide['PencilIcon']).toBe('Pencil');
    expect(heroiconToLucide['TrashIcon']).toBe('Trash');
  });

  test('maps navigation chevron icons', () => {
    expect(heroiconToLucide['ChevronDownIcon']).toBe('ChevronDown');
    expect(heroiconToLucide['ChevronLeftIcon']).toBe('ChevronLeft');
    expect(heroiconToLucide['ChevronRightIcon']).toBe('ChevronRight');
    expect(heroiconToLucide['ChevronUpDownIcon']).toBe('ChevronsUpDown');
  });

  test('maps arrow icons', () => {
    expect(heroiconToLucide['ArrowRightIcon']).toBe('ArrowRight');
    expect(heroiconToLucide['ArrowLeftIcon']).toBe('ArrowLeft');
    expect(heroiconToLucide['ArrowUpIcon']).toBe('ArrowUp');
    expect(heroiconToLucide['ArrowDownIcon']).toBe('ArrowDown');
  });

  test('maps search and input icons', () => {
    expect(heroiconToLucide['MagnifyingGlassIcon']).toBe('Search');
    expect(heroiconToLucide['FunnelIcon']).toBe('Filter');
    expect(heroiconToLucide['HashtagIcon']).toBe('Hash');
  });

  test('maps user and people icons', () => {
    expect(heroiconToLucide['UserIcon']).toBe('User');
    expect(heroiconToLucide['UserCircleIcon']).toBe('UserCircle');
    expect(heroiconToLucide['UserPlusIcon']).toBe('UserPlus');
    expect(heroiconToLucide['AtSymbolIcon']).toBe('AtSign');
  });

  test('maps content and media icons', () => {
    expect(heroiconToLucide['DocumentIcon']).toBe('File');
    expect(heroiconToLucide['PhotoIcon']).toBe('Image');
    expect(heroiconToLucide['VideoCameraIcon']).toBe('Video');
    expect(heroiconToLucide['PaperClipIcon']).toBe('Paperclip');
  });

  test('maps chart and data icons', () => {
    expect(heroiconToLucide['ChartPieIcon']).toBe('PieChart');
    expect(heroiconToLucide['ChartBarSquareIcon']).toBe('BarChart3');
    expect(heroiconToLucide['TableCellsIcon']).toBe('Table');
    expect(heroiconToLucide['ServerIcon']).toBe('Server');
    expect(heroiconToLucide['DatabaseIcon']).toBe('Database');
  });

  test('maps status and feedback icons', () => {
    expect(heroiconToLucide['ExclamationCircleIcon']).toBe('AlertCircle');
    expect(heroiconToLucide['ExclamationTriangleIcon']).toBe('AlertTriangle');
    expect(heroiconToLucide['InformationCircleIcon']).toBe('Info');
    expect(heroiconToLucide['QuestionMarkCircleIcon']).toBe('HelpCircle');
    expect(heroiconToLucide['CheckCircleIcon']).toBe('CheckCircle');
    expect(heroiconToLucide['XCircleIcon']).toBe('XCircle');
    expect(heroiconToLucide['CheckBadgeIcon']).toBe('BadgeCheck');
  });

  test('maps menu and settings icons', () => {
    expect(heroiconToLucide['Bars3Icon']).toBe('Menu');
    expect(heroiconToLucide['CogIcon']).toBe('Cog');
    expect(heroiconToLucide['SettingsIcon']).toBe('Settings');
  });

  test('maps object and item icons', () => {
    expect(heroiconToLucide['TagIcon']).toBe('Tag');
    expect(heroiconToLucide['BookmarkIcon']).toBe('Bookmark');
    expect(heroiconToLucide['BriefcaseIcon']).toBe('Briefcase');
    expect(heroiconToLucide['CreditCardIcon']).toBe('CreditCard');
    expect(heroiconToLucide['BanknotesIcon']).toBe('Banknote');
  });

  test('maps theme icons', () => {
    expect(heroiconToLucide['SunIcon']).toBe('Sun');
    expect(heroiconToLucide['MoonIcon']).toBe('Moon');
  });

  test('maps communication icons', () => {
    expect(heroiconToLucide['EnvelopeIcon']).toBe('Mail');
    expect(heroiconToLucide['EnvelopeOpenIcon']).toBe('MailOpen');
    expect(heroiconToLucide['PhoneIcon']).toBe('Phone');
    expect(heroiconToLucide['ChatBubbleLeftIcon']).toBe('MessageCircle');
  });

  test('maps action icons', () => {
    expect(heroiconToLucide['HeartIcon']).toBe('Heart');
    expect(heroiconToLucide['HandThumbUpIcon']).toBe('ThumbsUp');
    expect(heroiconToLucide['FlagIcon']).toBe('Flag');
    expect(heroiconToLucide['StarIcon']).toBe('Star');
    expect(heroiconToLucide['FireIcon']).toBe('Flame');
  });

  test('maps lock and security icons', () => {
    expect(heroiconToLucide['LockClosedIcon']).toBe('Lock');
    expect(heroiconToLucide['LockOpenIcon']).toBe('LockOpen');
    expect(heroiconToLucide['CommandLineIcon']).toBe('Command');
    expect(heroiconToLucide['CodeBracketIcon']).toBe('Code');
    expect(heroiconToLucide['FingerPrintIcon']).toBe('Fingerprint');
  });

  test('maps location and navigation icons', () => {
    expect(heroiconToLucide['MapPinIcon']).toBe('MapPin');
    expect(heroiconToLucide['GlobeAmericasIcon']).toBe('Globe');
    expect(heroiconToLucide['SignalIcon']).toBe('Signal');
  });

  test('maps alias icons to same target', () => {
    expect(heroiconToLucide['PlusSmallIcon']).toBe(heroiconToLucide['PlusIcon']);
    expect(heroiconToLucide['GlobeAmericasIcon']).toBe(heroiconToLucide['GlobeAltIcon']);
    expect(heroiconToLucide['ArrowLongRightIcon']).toBe(heroiconToLucide['ArrowRightIcon']);
    expect(heroiconToLucide['ArrowLongLeftIcon']).toBe(heroiconToLucide['ArrowLeftIcon']);
  });

  test('contains mappings for all Tailwind UI v4 reference icons', () => {
    const coreIcons = [
      'HomeIcon',
      'UsersIcon',
      'FolderIcon',
      'CalendarIcon',
      'BellIcon',
      'XMarkIcon',
      'CheckIcon',
      'CheckCircleIcon',
      'ChevronDownIcon',
      'ChevronLeftIcon',
      'ChevronRightIcon',
      'Bars3Icon',
      'MagnifyingGlassIcon',
      'UserIcon',
      'DocumentDuplicateIcon',
      'DocumentIcon',
      'PencilIcon',
      'TrashIcon',
      'PlusIcon',
      'MinusIcon',
      'StarIcon',
      'HeartIcon',
      'LinkIcon',
      'PaperClipIcon',
      'CreditCardIcon',
      'VideoCameraIcon',
      'PhoneIcon',
      'MapPinIcon',
      'FlagIcon',
      'ChartPieIcon',
      'CogIcon',
      'InboxIcon',
      'ClockIcon',
    ];

    for (const icon of coreIcons) {
      expect(heroiconToLucide).toHaveProperty(icon);
    }
  });

  test('all mapped lucide icons exist in lucide-preact', () => {
    const missingIcons: string[] = [];
    const availableIconNames = Object.keys(lucideIcons);

    for (const [heroiconName, lucideName] of Object.entries(heroiconToLucide)) {
      const hasBaseName = availableIconNames.includes(lucideName);
      const hasIconName = availableIconNames.includes(lucideName + 'Icon');

      if (!hasBaseName && !hasIconName) {
        missingIcons.push(`${heroiconName} -> ${lucideName}`);
      }
    }

    expect(missingIcons).toEqual([]);
  });
});
