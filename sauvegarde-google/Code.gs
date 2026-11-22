/**
 * Stash : sauvegarde en ligne dans ton Google Drive.
 *
 * Ce script reçoit les données de Stash et les range dans le dossier
 * « Stash – sauvegardes » de ton Drive :
 *   - stash-derniere.json      : la sauvegarde la plus récente
 *   - stash-AAAA-MM-JJ.json    : une copie par jour, gardée 30 jours
 * Ces fichiers ont le même format qu'un export : ils peuvent aussi
 * s'importer à la main dans Stash (Réglages > Importer).
 * Il refuse toute sauvegarde vide, pour qu'une appli effacée
 * n'écrase jamais tes données.
 *
 * À publier une seule fois : Déployer > Nouveau déploiement > Application Web,
 * « Exécuter en tant que : Moi », « Qui a accès : Tout le monde ».
 * Le lien obtenu (…/exec) se colle dans Stash : Réglages > Sauvegarde en ligne.
 */

var NOM_DOSSIER = 'Stash – sauvegardes';
var FICHIER_COURANT = 'stash-derniere.json';
var JOURS_GARDES = 30;
var FUSEAU = 'Europe/Paris';

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'ping') return repondre_(etat_());
  if (action === 'load') return repondre_(charger_());
  return ContentService.createTextOutput(
    'Sauvegarde Stash : prête. Copie l’adresse de cette page et colle-la dans Stash (Réglages > Sauvegarde en ligne).'
  );
}

function doPost(e) {
  var corps;
  try {
    corps = JSON.parse(e.postData.contents);
  } catch (err) {
    return repondre_({ ok: false, erreur: 'Données illisibles.' });
  }
  if (corps.action === 'save') return repondre_(sauver_(corps.sauvegarde));
  if (corps.action === 'load') return repondre_(charger_());
  if (corps.action === 'ping') return repondre_(etat_());
  return repondre_({ ok: false, erreur: 'Action inconnue.' });
}

/* Résumé : opérations, placements, catégories, solde de départ renseigné ou non */
function compter_(s) {
  var n = function (k) { return s && Array.isArray(s[k]) ? s[k].length : 0; };
  return { o: n('tx'), p: n('pots'), c: n('cats'), a: !!(s && s.anchor) };
}
function vide_(nb) { return !nb.o && !nb.p && !nb.a; }

function sauver_(s) {
  if (!s || s.app !== 'stash' || !Array.isArray(s.cats) || !Array.isArray(s.tx)) {
    return { ok: false, erreur: 'Ce n’est pas une sauvegarde de Stash.' };
  }
  var nb = compter_(s);
  if (vide_(nb)) {
    return { ok: false, erreur: 'Sauvegarde vide refusée : la précédente est gardée.' };
  }
  var verrou = LockService.getScriptLock();
  verrou.waitLock(20000);
  try {
    var dossier = dossier_();
    var contenu = JSON.stringify(s);
    ecrire_(dossier, FICHIER_COURANT, contenu);
    ecrire_(dossier, 'stash-' + Utilities.formatDate(new Date(), FUSEAU, 'yyyy-MM-dd') + '.json', contenu);
    nettoyer_(dossier);
    return { ok: true, le: new Date().toISOString(), nb: nb };
  } finally {
    verrou.releaseLock();
  }
}

function charger_() {
  var f = fichierCourant_();
  if (!f) return { ok: true, sauvegarde: null };
  return { ok: true, le: f.getLastUpdated().toISOString(), sauvegarde: JSON.parse(f.getBlob().getDataAsString('UTF-8')) };
}

function etat_() {
  var f = fichierCourant_();
  if (!f) return { ok: true, app: 'stash-sauvegarde', derniere: null };
  var s = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
  return { ok: true, app: 'stash-sauvegarde', derniere: { le: f.getLastUpdated().toISOString(), nb: compter_(s) } };
}

/* Dossier retrouvé par son identifiant, recréé s'il a été supprimé */
function dossier_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('dossierId');
  if (id) {
    try {
      var d = DriveApp.getFolderById(id);
      if (!d.isTrashed()) return d;
    } catch (err) {}
  }
  var nouveau = DriveApp.createFolder(NOM_DOSSIER);
  props.setProperty('dossierId', nouveau.getId());
  return nouveau;
}

function fichierCourant_() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('dossierId')) return null;
  var it = dossier_().getFilesByName(FICHIER_COURANT);
  return it.hasNext() ? it.next() : null;
}

function ecrire_(dossier, nom, contenu) {
  var it = dossier.getFilesByName(nom);
  if (it.hasNext()) it.next().setContent(contenu);
  else dossier.createFile(nom, contenu, 'application/json');
}

function nettoyer_(dossier) {
  var limite = Utilities.formatDate(new Date(Date.now() - JOURS_GARDES * 864e5), FUSEAU, 'yyyy-MM-dd');
  var it = dossier.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var m = /^stash-(\d{4}-\d{2}-\d{2})\.json$/.exec(f.getName());
    if (m && m[1] < limite) f.setTrashed(true);
  }
}

function repondre_(objet) {
  return ContentService.createTextOutput(JSON.stringify(objet)).setMimeType(ContentService.MimeType.JSON);
}

/* À lancer une fois depuis l'éditeur (bouton Exécuter) pour donner l'autorisation d'accès au Drive. */
function autoriser() {
  dossier_();
  Logger.log('Autorisation OK. Dossier : ' + NOM_DOSSIER);
}
