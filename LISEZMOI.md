# 🍔 Serveur WhatsApp Mon Bocadillo (Version VPS 24/7)

Ce dossier contient le serveur WhatsApp de **Mon Bocadillo**, spécialement configuré pour tourner sur un **VPS Linux (Ubuntu / Debian)** de façon continue **24h/24 et 7j/7**, sans coupure et sans saturer la RAM.

Contrairement aux solutions lourdes avec Chrome/Puppeteer qui consomment 500 Mo à 1 Go de RAM, ce serveur utilise **Baileys (Pure WebSocket)** :
- ⚡ **Ultra-léger** (~40 Mo de RAM seulement).
- ⚡ **Zéro dépendance graphique** (Pas besoin de Chrome, Puppeteer, ni de bibliothèques X11).
- ⚡ **Multi-lignes supporté** (Ligne Principale, Lignes Secondaires).
- ⚡ **Hub Web & QR Terminal** (Affichage direct du QR Code dans le terminal SSH `pm2 logs` ET sur l'interface web).
- ⚡ **Auto-Reconnexion 24/7** (En cas de micro-coupure internet, il se reconnecte immédiatement).

---

## 🚀 Guide d'Installation Rapide sur le VPS

### Étape 1 : Envoyer le dossier sur le VPS
Vous avez l'archive `bocadillo-whatsapp-server.zip` prête sur votre Bureau (Desktop) ou dans ce dossier.
Envoyez-la sur votre VPS via **FileZilla**, **WinSCP** ou en ligne de commande :
```bash
# Exemple avec scp depuis votre PC :
scp bocadillo-whatsapp-server.zip root@VOTRE_IP_VPS:/root/
```

### Étape 2 : Vous connecter au VPS et dézipper
```bash
ssh root@VOTRE_IP_VPS
unzip bocadillo-whatsapp-server.zip -d bocadillo-whatsapp-server
cd bocadillo-whatsapp-server
```

### Étape 3 : Lancer l'installation automatique
Rendez le script exécutable et lancez-le :
```bash
chmod +x setup_vps.sh
./setup_vps.sh
```

*(Ou si vous préférez exécuter les commandes manuellement une par une) :*
```bash
# 1. Installer Node.js 20 & PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# 2. Installer les modules
npm install

# 3. Lancer avec PM2
pm2 start ecosystem.config.js

# 4. Activer le démarrage automatique au reboot du VPS
pm2 save
pm2 startup
```

---

## 📱 Comment Scanner le QR Code et Connecter WhatsApp

Dès que le serveur est démarré :

### Méthode 1 (La plus rapide - Dans le terminal SSH) :
Tapez simplement :
```bash
pm2 logs bocadillo-whatsapp
```
Le QR Code s'affiche directement dans votre console en noir et blanc !
1. Ouvrez WhatsApp sur votre téléphone.
2. Allez dans **Appareils connectés** > **Connecter un appareil**.
3. Scannez le QR Code affiché dans le terminal.
4. Dès qu'il est connecté, vous verrez :
   ```
   🎉 ==============================================
   ✅ LIGNE CONNECTÉE : "Ligne WhatsApp"
   📞 Numéro Actif   : 06...
   ==============================================
   ```

### Méthode 2 (Via le Web Hub) :
Ouvrez dans votre navigateur :
`http://VOTRE_IP_VPS:3002`
*(Ou `https://bocadillo.136.116.62.73.nip.io` si vous utilisez le reverse-proxy Caddy configuré)*.
Le QR Code s'affiche avec actualisation automatique toutes les 5 secondes.

### Méthode 3 (Depuis la Caisse Mon Bocadillo) :
Dans le panneau d'administration de la caisse (Admin > WhatsApp Hub), le QR Code s'affiche directement car il est synchronisé en temps réel avec Firebase !

---

## 🛠️ Commandes Utiles pour Gérer le Bot sur le VPS

| Action | Commande |
| :--- | :--- |
| **Voir les logs en direct** | `pm2 logs bocadillo-whatsapp` |
| **Vérifier l'état** | `pm2 status` |
| **Redémarrer le bot** | `pm2 restart bocadillo-whatsapp` |
| **Arrêter le bot** | `pm2 stop bocadillo-whatsapp` |
| **Voir la consommation RAM/CPU** | `pm2 monit` |

---

## 🔄 Que se passe-t-il en cas de coupure ou redémarrage du VPS ?
- Grâce à `pm2 save` et `pm2 startup`, si le VPS redémarre ou subit une coupure de courant, le serveur WhatsApp se relance automatiquement dès que le système revient en ligne.
- La session WhatsApp est sauvegardée dans le dossier `auth_sessions/`, vous n'aurez **jamais besoin de rescanner le QR Code** après un reboot.
