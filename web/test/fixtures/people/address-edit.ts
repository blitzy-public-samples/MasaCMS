import type { components } from '@/generated/clients/people';
import type { AddressEditData, AddressExtendSetLoader } from '@/screens/cusers/editaddress';
import { USER_IDS } from '../session';
import { PERSON_IDS } from './user-list';

// Typed as `AddressRecord`, the bootstrap-cased row that getAddressEdit, getUserEdit and getProfile all carry.
type AddressRecord = components['schemas']['AddressRecord'];
type PersonRecord = components['schemas']['PersonRecord'];
type AddressExtendSets = Awaited<ReturnType<AddressExtendSetLoader>>;

export const ADDRESS_IDS = Object.freeze({
  janeSmithHome: '7C1E0B01-4B2D-4E6F-8A9B0C1D2E3F4B01',
  systemUserHome: '7C1E0B02-4B2D-4E6F-8A9B0C1D2E3F4B02',
  janeSmithNew: '7C1E0B03-4B2D-4E6F-8A9B0C1D2E3F4B03',
} as const);

const janeSmithPerson: PersonRecord = Object.freeze({
  UserID: PERSON_IDS.janeSmith,
  GroupName: '',
  Fname: 'Jane',
  Lname: 'Smith',
  UserName: 'jane_smith',
  PasswordCreated: '2026-02-16T09:30:00.000',
  Email: 'jane_smith@example.com',
  Company: '',
  JobTitle: '',
  mobilePhone: '',
  Website: '',
  Type: 2,
  subType: 'Default',
  Ext: null,
  ContactForm: '',
  Admin: null,
  S2: 0,
  LastLogin: '2026-10-28T08:12:00.000',
  LastUpdate: '2026-10-29T14:20:00.000',
  LastUpdateBy: 'Tessa Admin',
  LastUpdateByID: USER_IDS.tenantASiteAdmin,
  Perm: 0,
  InActive: 0,
  isPublic: 0,
  SiteID: 'tenant-a',
  Subscribe: 0,
  notes: '',
  description: '',
  interests: '',
  keepPrivate: 0,
  photoFileID: '',
  photoFileExt: '',
  IMName: '',
  IMService: '',
  created: '2026-02-16T09:30:00.000',
  remoteID: '',
  tags: '',
  tablist: '',
});

export const janeSmithHomeAddress: AddressRecord = Object.freeze({
  addressID: ADDRESS_IDS.janeSmithHome,
  userID: PERSON_IDS.janeSmith,
  siteID: 'tenant-a',
  addressName: 'Home',
  address1: '100 Example Street',
  address2: 'Suite 2',
  city: 'Springfield',
  state: 'IL',
  zip: '62701',
  country: 'United States',
  phone: '555-0100',
  fax: '555-0199',
  isPrimary: 1,
  addressNotes: 'Ring the side door.',
  addressURL: 'http://www.example.com/jane-smith',
  longitude: -89.6501,
  latitude: 39.7817,
  addressEmail: 'jane_smith.home@example.com',
  hours: 'Mon-Fri 9:00-17:00\nSat 10:00-14:00',
});

export const systemUserHomeAddress: AddressRecord = Object.freeze({
  addressID: ADDRESS_IDS.systemUserHome,
  userID: PERSON_IDS.systemUser,
  siteID: 'tenant-a',
  addressName: 'Home',
  address1: '200 Sample Avenue',
  address2: '',
  city: 'Riverton',
  state: 'OR',
  zip: '97001',
  country: 'United States',
  phone: '555-0110',
  fax: '',
  isPrimary: 1,
  addressNotes: '',
  addressURL: '',
  longitude: null,
  latitude: null,
  addressEmail: 'casey_taylor.home@example.com',
  hours: 'Mon-Thu 8:00-16:00\nFri 8:00-12:00',
});

// getAddressEdit carries only the stored values; the Address set itself is what the screen's extend-set loader returns.
export const addressExtendSets: AddressExtendSets = Object.freeze([
  Object.freeze({
    extendSetID: '7C1E0B11-4B2D-4E6F-8A9B0C1D2E3F4B11',
    categoryID: '',
    name: 'Delivery',
    attributes: Object.freeze([
      Object.freeze({
        attributeID: 7101,
        name: 'deliveryInstructions',
        label: 'Delivery Instructions',
        hint: '',
        type: 'TextBox',
        adminOnly: 0,
        required: 'false',
        validation: '',
        regex: '',
        message: '',
        defaultValue: '',
        optionList: '',
        optionLabelList: '',
      }),
    ]),
  }),
]);

export const existingAddressEditData: AddressEditData = Object.freeze({
  user: janeSmithPerson,
  address: janeSmithHomeAddress,
  isNew: false,
  extendedAttributes: Object.freeze({ deliveryInstructions: 'Leave parcels at the front desk.' }),
});

export const newAddressEditData: AddressEditData = Object.freeze({
  user: janeSmithPerson,
  address: Object.freeze({
    addressID: ADDRESS_IDS.janeSmithNew,
    userID: PERSON_IDS.janeSmith,
    siteID: null,
    addressName: null,
    address1: null,
    address2: null,
    city: null,
    state: null,
    zip: null,
    country: null,
    phone: null,
    fax: null,
    isPrimary: null,
    addressNotes: null,
    addressURL: null,
    longitude: null,
    latitude: null,
    addressEmail: null,
    hours: null,
  }),
  isNew: true,
  extendedAttributes: Object.freeze({}),
});
