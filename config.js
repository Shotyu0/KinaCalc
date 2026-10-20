// Connects the page to the Firebase project that holds the shared price book. These values only
// identify the project, so they're safe to publish: who can read and write is enforced by
// firestore.rules. Set `firebase` to null to keep everyone's prices in their own browser instead.
window.KINA_CONFIG = {
  firebase: {
    apiKey: 'AIzaSyBNOibB0dfrNlv71ft4vqfUhtqBVDDijIY',
    authDomain: 'kina-ledger.firebaseapp.com',
    projectId: 'kina-ledger',
    appId: '1:244922754780:web:eecddfd05c5accfc767619'
  }
};
