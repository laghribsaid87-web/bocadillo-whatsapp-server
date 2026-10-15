#!/bin/bash
set -e

echo "=========================================================="
echo "🚀 INSTALLATION SERVEUR WHATSAPP MON BOCADILLO (VPS 24/7)"
echo "=========================================================="

# 1. Mise à jour système et installation Node.js si absent
if ! command -v node &> /dev/null; then
    echo "📦 Installation de Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "✅ Node.js est déjà installé: $(node -v)"
fi

# 2. Installation de PM2 en global si absent
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installation de PM2..."
    sudo npm install -g pm2
else
    echo "✅ PM2 est déjà installé."
fi

# 3. Installation des dépendances NPM
echo "📦 Installation des dépendances..."
npm install

# 4. Lancement du bot avec PM2
echo "🚀 Démarrage du serveur WhatsApp..."
pm2 start ecosystem.config.js || pm2 restart bocadillo-whatsapp

# 5. Sauvegarde de la configuration PM2 pour redémarrer automatiquement après un reboot du VPS
echo "💾 Sauvegarde de la configuration 24/7..."
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME 2>/dev/null || pm2 startup 2>/dev/null || true

echo ""
echo "=========================================================="
echo "✅ BOT WHATSAPP MON BOCADILLO EST EN LIGNE (24/7) !"
echo "=========================================================="
echo "👉 Pour voir le terminal et scanner le QR Code :"
echo "   pm2 logs bocadillo-whatsapp"
echo ""
echo "👉 Pour voir le Hub Web direct :"
echo "   http://VOTRE_IP_VPS:3002"
echo ""
echo "👉 Pour vérifier le statut :"
echo "   pm2 status"
echo "=========================================================="
